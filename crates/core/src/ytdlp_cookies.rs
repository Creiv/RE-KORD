//! YouTube cookies handed to yt-dlp.
//!
//! yt-dlp rewrites the `--cookies` jar when it exits. Pointing every run at the
//! stored file therefore had two failure modes: concurrent runs (a download,
//! a track-count probe, a preview) raced on the same file, and a read-only
//! source (Docker `:ro` mount, `REKORD_YTDLP_COOKIES` on a read-only path)
//! made the final save fail.
//!
//! Each invocation now gets its own copy ([`YtdlpCookies`]): a mode-600 file
//! under `<data_dir>/tmp/ytdlp-cookies/`, removed when the guard drops (after
//! the process has exited). The stored file is never touched by yt-dlp.
//!
//! The one exception is [`YtdlpCookies::write_back`]: after a *successful
//! download* the refreshed jar is copied back, so rotated session cookies are
//! kept. It only happens when the source is the hub-managed file (uploaded from
//! Settings, not provided by the environment), when the source has not changed
//! since the copy was taken (a new upload always wins), when the refreshed jar
//! still validates, and under a process-wide lock with an atomic rename.
//! Probes and previews never write back.

use crate::config::AppConfig;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// Copies older than this are leftovers of a crash: removed on the next run.
const STALE_AFTER: Duration = Duration::from_secs(6 * 3600);

/// Serializes write-backs (two downloads finishing together).
static WRITE_BACK: Mutex<()> = Mutex::new(());

/// Why an uploaded file was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieFormatError {
    Empty,
    /// A JSON export (browser extensions offer both formats).
    Json,
    NotNetscape,
    /// Well-formed header but not a single cookie line.
    NoCookies,
}

impl CookieFormatError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "the cookies file is empty",
            Self::Json => "the cookies file is JSON: export it in Netscape (cookies.txt) format",
            Self::NotNetscape => "file is not a Netscape cookies.txt",
            Self::NoCookies => "the cookies file contains no cookies",
        }
    }
}

/// What a cookies file contains.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CookieStats {
    pub entries: usize,
    pub youtube_entries: usize,
}

fn cookie_line_fields(line: &str) -> Option<Vec<&str>> {
    // `#HttpOnly_` prefixed lines are real cookies in the Netscape format.
    let l = line.trim_end_matches(['\r', '\n']);
    let l = l.strip_prefix("#HttpOnly_").unwrap_or(l);
    if l.trim().is_empty() || l.starts_with('#') {
        return None;
    }
    let fields: Vec<&str> = l.split('\t').collect();
    (fields.len() >= 6).then_some(fields)
}

/// Validate a Netscape cookies.txt and count its entries.
pub fn check_cookie_text(text: &str) -> Result<CookieStats, CookieFormatError> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Err(CookieFormatError::Empty);
    }
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        return Err(CookieFormatError::Json);
    }
    let mut stats = CookieStats::default();
    for line in trimmed.lines() {
        if let Some(fields) = cookie_line_fields(line) {
            stats.entries += 1;
            let domain = fields[0].trim().to_ascii_lowercase();
            if domain.ends_with("youtube.com") || domain.ends_with("google.com") {
                stats.youtube_entries += 1;
            }
        }
    }
    let head: String = trimmed.lines().take(40).collect::<Vec<_>>().join("\n");
    let header =
        head.contains("# Netscape HTTP Cookie File") || head.contains("# HTTP Cookie File");
    if stats.entries == 0 {
        return Err(if header {
            CookieFormatError::NoCookies
        } else {
            CookieFormatError::NotNetscape
        });
    }
    Ok(stats)
}

/// File-level check used before handing a file to yt-dlp.
pub fn is_netscape_cookies(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|t| check_cookie_text(&t).is_ok())
        .unwrap_or(false)
}

/// Cookie state shown in Settings and the admin Integrations panel.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CookieStatus {
    pub present: bool,
    pub valid: bool,
    pub entries: usize,
    pub youtube_entries: usize,
    /// RFC 3339 modification time of the stored file.
    pub updated_at: Option<String>,
}

pub fn cookie_status(path: Option<&Path>) -> CookieStatus {
    let Some(path) = path else {
        return CookieStatus::default();
    };
    let Ok(meta) = fs::metadata(path) else {
        return CookieStatus::default();
    };
    if !meta.is_file() {
        return CookieStatus::default();
    }
    let updated_at = meta.modified().ok().map(|t| {
        chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    });
    let stats = fs::read_to_string(path)
        .ok()
        .and_then(|t| check_cookie_text(&t).ok());
    CookieStatus {
        present: true,
        valid: stats.is_some(),
        entries: stats.map(|s| s.entries).unwrap_or(0),
        youtube_entries: stats.map(|s| s.youtube_entries).unwrap_or(0),
        updated_at,
    }
}

/// Write `bytes` to `dest` atomically (sibling temp file + rename), mode 600.
pub fn write_private_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cookies".into());
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let res = (|| {
        let mut f = create_private(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dest)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

fn create_private(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

fn copies_dir(cfg: &AppConfig) -> PathBuf {
    cfg.data_dir.join("tmp").join("ytdlp-cookies")
}

fn sweep_stale(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE_AFTER);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// A private copy of the stored cookies for one yt-dlp run; removed on drop.
#[derive(Debug)]
pub struct YtdlpCookies {
    copy: PathBuf,
    source: PathBuf,
    source_mtime: Option<SystemTime>,
    /// The source is the hub-managed upload (not an env-provided path).
    managed: bool,
}

impl YtdlpCookies {
    /// Copy the configured cookies, or `None` when there are none (or the copy
    /// failed: yt-dlp then runs without cookies rather than not at all).
    pub fn prepare(cfg: &AppConfig) -> Option<Self> {
        let source = cfg.youtube_cookies_for_ytdlp()?;
        let bytes = match fs::read(&source) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "youtube cookies unreadable");
                return None;
            }
        };
        let source_mtime = fs::metadata(&source).and_then(|m| m.modified()).ok();
        let dir = copies_dir(cfg);
        if let Err(e) = fs::create_dir_all(&dir) {
            tracing::warn!(error = %e, "cookie copy dir");
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        sweep_stale(&dir);
        let copy = dir.join(format!("cookies-{}.txt", uuid::Uuid::new_v4().simple()));
        let written = create_private(&copy).and_then(|mut f| f.write_all(&bytes));
        if let Err(e) = written {
            tracing::warn!(error = %e, "cookie copy failed");
            let _ = fs::remove_file(&copy);
            return None;
        }
        Some(Self {
            copy,
            source,
            source_mtime,
            managed: !cfg.youtube_cookies_from_env,
        })
    }

    pub fn path(&self) -> &Path {
        &self.copy
    }

    /// `--cookies <copy>`.
    pub fn args(&self) -> [String; 2] {
        ["--cookies".into(), self.copy.to_string_lossy().into_owned()]
    }

    /// After a successful download: keep the cookies yt-dlp refreshed (see the
    /// module docs for the conditions). Returns whether the source was updated.
    pub fn write_back(&self) -> bool {
        if !self.managed {
            return false;
        }
        let _guard = WRITE_BACK.lock().unwrap_or_else(|e| e.into_inner());
        let now_mtime = fs::metadata(&self.source).and_then(|m| m.modified()).ok();
        if now_mtime.is_none() || now_mtime != self.source_mtime {
            // Cleared or replaced meanwhile: the user's newer file wins.
            return false;
        }
        let Ok(fresh) = fs::read(&self.copy) else {
            return false;
        };
        let Ok(text) = std::str::from_utf8(&fresh) else {
            return false;
        };
        if check_cookie_text(text).is_err() {
            return false;
        }
        if fs::read(&self.source).is_ok_and(|old| old == fresh) {
            return false;
        }
        match write_private_atomic(&self.source, &fresh) {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!(error = %e, "cookie write-back skipped");
                false
            }
        }
    }
}

impl Drop for YtdlpCookies {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.copy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Netscape HTTP Cookie File\n\
        .youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc\n\
        #HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef\n\
        .example.org\tTRUE\t/\tFALSE\t0\tx\ty\n";

    fn temp_cfg() -> (AppConfig, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rekord-cookies-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let cfg = AppConfig::resolve(Some(dir.clone()), "127.0.0.1:0".parse().unwrap(), None);
        (cfg, dir)
    }

    #[test]
    fn validates_netscape_and_counts_youtube_entries() {
        let s = check_cookie_text(SAMPLE).unwrap();
        assert_eq!(s.entries, 3);
        assert_eq!(s.youtube_entries, 2);
        assert_eq!(check_cookie_text(""), Err(CookieFormatError::Empty));
        assert_eq!(check_cookie_text("  \n"), Err(CookieFormatError::Empty));
        assert_eq!(
            check_cookie_text(r#"[{"domain":".youtube.com","name":"SID"}]"#),
            Err(CookieFormatError::Json)
        );
        assert_eq!(
            check_cookie_text("SID=abc; HSID=def"),
            Err(CookieFormatError::NotNetscape)
        );
        assert_eq!(
            check_cookie_text("# Netscape HTTP Cookie File\n"),
            Err(CookieFormatError::NoCookies)
        );
        // BOM and CRLF line endings from Windows exports.
        let crlf = format!("\u{feff}{}", SAMPLE.replace('\n', "\r\n"));
        assert_eq!(check_cookie_text(&crlf).unwrap().entries, 3);
    }

    #[test]
    fn copy_is_private_used_and_removed() {
        let (mut cfg, dir) = temp_cfg();
        assert!(
            YtdlpCookies::prepare(&cfg).is_none(),
            "no cookies configured"
        );
        let src = cfg.default_youtube_cookies_path();
        fs::write(&src, SAMPLE).unwrap();
        cfg.youtube_cookies_path = Some(src.clone());
        let jar = YtdlpCookies::prepare(&cfg).expect("copy");
        let copy = jar.path().to_path_buf();
        assert_ne!(copy, src);
        assert!(copy.starts_with(dir.join("tmp")));
        assert_eq!(fs::read_to_string(&copy).unwrap(), SAMPLE);
        assert_eq!(jar.args()[0], "--cookies");
        assert_eq!(PathBuf::from(&jar.args()[1]), copy);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Two runs at once get two distinct files.
        let other = YtdlpCookies::prepare(&cfg).expect("second copy");
        assert_ne!(other.path(), copy.as_path());
        drop(jar);
        drop(other);
        assert!(!copy.exists(), "copy removed with the guard");
        assert_eq!(
            fs::read_to_string(&src).unwrap(),
            SAMPLE,
            "source untouched"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_source_still_works_and_is_never_written() {
        use std::os::unix::fs::PermissionsExt;
        let (mut cfg, dir) = temp_cfg();
        let ro_dir = dir.join("ro");
        fs::create_dir_all(&ro_dir).unwrap();
        let src = ro_dir.join("cookies.txt");
        fs::write(&src, SAMPLE).unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o400)).unwrap();
        fs::set_permissions(&ro_dir, fs::Permissions::from_mode(0o500)).unwrap();
        cfg.youtube_cookies_path = Some(src.clone());
        cfg.youtube_cookies_from_env = true;
        let jar = YtdlpCookies::prepare(&cfg).expect("copy of a read-only file");
        // yt-dlp saves its jar on exit: the copy is writable.
        fs::write(
            jar.path(),
            format!("{SAMPLE}.youtube.com\tTRUE\t/\tTRUE\t0\tNEW\t1\n"),
        )
        .unwrap();
        assert!(!jar.write_back(), "env-provided source is never written");
        assert_eq!(fs::read_to_string(&src).unwrap(), SAMPLE);
        drop(jar);
        fs::set_permissions(&ro_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_back_only_keeps_valid_refreshed_jars_of_an_unchanged_upload() {
        let (mut cfg, dir) = temp_cfg();
        let src = cfg.default_youtube_cookies_path();
        fs::write(&src, SAMPLE).unwrap();
        cfg.youtube_cookies_path = Some(src.clone());

        let jar = YtdlpCookies::prepare(&cfg).unwrap();
        assert!(!jar.write_back(), "unchanged jar: nothing to write");
        let refreshed = format!("{SAMPLE}.youtube.com\tTRUE\t/\tTRUE\t0\tNEW\t1\n");
        fs::write(jar.path(), &refreshed).unwrap();
        assert!(jar.write_back());
        assert_eq!(fs::read_to_string(&src).unwrap(), refreshed);
        drop(jar);

        // A broken jar is not written back.
        let jar = YtdlpCookies::prepare(&cfg).unwrap();
        fs::write(jar.path(), "garbage").unwrap();
        assert!(!jar.write_back());
        assert_eq!(fs::read_to_string(&src).unwrap(), refreshed);
        drop(jar);

        // A new upload during the run wins.
        let jar = YtdlpCookies::prepare(&cfg).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let uploaded = format!("{SAMPLE}.youtube.com\tTRUE\t/\tTRUE\t0\tUP\t2\n");
        fs::write(&src, &uploaded).unwrap();
        let mtime = fs::metadata(&src).unwrap().modified().unwrap();
        if Some(mtime) != jar.source_mtime {
            fs::write(jar.path(), &refreshed).unwrap();
            assert!(!jar.write_back());
            assert_eq!(fs::read_to_string(&src).unwrap(), uploaded);
        }
        drop(jar);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upload_validates_before_replacing_and_is_private() {
        let (mut cfg, dir) = temp_cfg();
        let dest = cfg.set_youtube_cookies_bytes(SAMPLE.as_bytes()).unwrap();
        assert_eq!(cfg.youtube_cookies_for_ytdlp(), Some(dest.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let json = cfg
            .set_youtube_cookies_bytes(br#"[{"domain":".youtube.com"}]"#)
            .unwrap_err();
        assert_eq!(json.to_string(), CookieFormatError::Json.message());
        let bad = cfg.set_youtube_cookies_bytes(b"hello").unwrap_err();
        assert_eq!(bad.to_string(), CookieFormatError::NotNetscape.message());
        // The good file survived both refusals.
        assert_eq!(fs::read_to_string(&dest).unwrap(), SAMPLE);
        let snap = cfg.config_snapshot();
        assert_eq!(snap["youtubeCookiesValid"], true);
        assert_eq!(snap["youtubeCookiesYoutubeEntries"], 2);
        assert!(snap["youtubeCookiesUpdatedAt"].is_string());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_presence_validity_and_date() {
        let (_cfg, dir) = temp_cfg();
        let p = dir.join("c.txt");
        assert_eq!(cookie_status(Some(&p)), CookieStatus::default());
        assert_eq!(cookie_status(None), CookieStatus::default());
        fs::write(&p, "nope").unwrap();
        let s = cookie_status(Some(&p));
        assert!(s.present && !s.valid && s.updated_at.is_some());
        fs::write(&p, SAMPLE).unwrap();
        let s = cookie_status(Some(&p));
        assert!(s.present && s.valid);
        assert_eq!((s.entries, s.youtube_entries), (3, 2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (_cfg, dir) = temp_cfg();
        let p = dir.join("youtube-cookies.txt");
        fs::write(&p, "old").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
        write_private_atomic(&p, SAMPLE.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), SAMPLE);
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
