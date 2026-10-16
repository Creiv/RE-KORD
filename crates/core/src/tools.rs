//! External tools the hub drives: yt-dlp (Studio downloads), ffmpeg / ffprobe
//! (yt-dlp post-processing, Cast transcode) and cloudflared (tunnel).
//!
//! Every tool is looked up in a fixed order of candidate locations; when more
//! than one exists, the newest `--version` wins (ties go to the earlier
//! candidate). For yt-dlp the order is:
//!
//! 1. config `ytdlp_path` (settings.json, or `YTDLP_PATH` folded in by the config)
//! 2. `YTDLP_PATH`
//! 3. the copy installed by "update yt-dlp" (`<data_dir>/tools/yt-dlp`)
//! 4. bundled copies: next to the executable, `bin/`, `../resources/bin`,
//!    `resources/bin`, macOS `../Resources/bin`, `REKORD_TOOLS_DIR`, and in
//!    development `release/bin/<platform>`
//! 5. `PATH`
//!
//! Probing runs subprocesses, so it never happens on an async worker
//! (`spawn_blocking`), and results are cached for [`VERSION_TTL`]. An update
//! invalidates the cache.

use crate::config::AppConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a resolved tool (path + version) is trusted.
pub const VERSION_TTL: Duration = Duration::from_secs(10 * 60);
/// yt-dlp older than this is flagged `stale` (YouTube breaks old releases).
pub const YTDLP_STALE_DAYS: i64 = 60;
/// A `--version` probe that takes longer is considered broken (the yt-dlp
/// one-file build unpacks itself on first run, so be generous).
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    Ytdlp,
    Ffmpeg,
    Ffprobe,
    Cloudflared,
}

impl Tool {
    pub fn id(self) -> &'static str {
        match self {
            Self::Ytdlp => "ytdlp",
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::Cloudflared => "cloudflared",
        }
    }

    fn stem(self) -> &'static str {
        match self {
            Self::Ytdlp => "yt-dlp",
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::Cloudflared => "cloudflared",
        }
    }

    /// Executable file name on this platform.
    pub fn file_name(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.stem())
        } else {
            self.stem().to_string()
        }
    }

    fn env_vars(self) -> &'static [&'static str] {
        match self {
            Self::Ytdlp => &["YTDLP_PATH"],
            Self::Ffmpeg => &["REKORD_FFMPEG", "FFMPEG_PATH", "REKORD_FFMPEG_BIN"],
            Self::Ffprobe => &["REKORD_FFPROBE", "FFPROBE_PATH"],
            Self::Cloudflared => &["REKORD_CLOUDFLARED_BIN"],
        }
    }

    fn version_args(self) -> &'static [&'static str] {
        match self {
            Self::Ffmpeg | Self::Ffprobe => &["-version"],
            _ => &["--version"],
        }
    }
}

/// Where the hub looks for a tool. `config_path` is yt-dlp's configured path;
/// `data_dir` holds the updated yt-dlp copy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ToolContext {
    pub config_path: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

impl ToolContext {
    pub fn from_config(cfg: &AppConfig) -> Self {
        Self {
            config_path: cfg.ytdlp_path.clone(),
            data_dir: Some(cfg.data_dir.clone()),
        }
    }

    /// Context relevant for `tool` (only yt-dlp uses config path / data dir),
    /// so the cache is shared by every hub for the other tools.
    fn for_tool(&self, tool: Tool) -> Self {
        match tool {
            Tool::Ytdlp => self.clone(),
            _ => Self::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedCandidate {
    pub path: PathBuf,
    pub source: &'static str,
    /// The probe ran and exited (the binary is usable on this machine).
    pub runs: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTool {
    pub tool: &'static str,
    pub available: bool,
    /// Chosen binary, or the bare file name (PATH lookup at spawn) when none runs.
    pub path: PathBuf,
    pub source: Option<&'static str>,
    pub version: Option<String>,
    pub candidates: Vec<ProbedCandidate>,
    #[serde(skip)]
    pub resolved_at: Option<Instant>,
}

impl ResolvedTool {
    fn missing(tool: Tool, candidates: Vec<ProbedCandidate>) -> Self {
        Self {
            tool: tool.id(),
            available: false,
            path: PathBuf::from(tool.file_name()),
            source: None,
            version: None,
            candidates,
            resolved_at: Some(Instant::now()),
        }
    }

    fn is_fresh(&self) -> bool {
        self.resolved_at
            .map(|t| t.elapsed() < VERSION_TTL)
            .unwrap_or(false)
    }
}

/// `<data_dir>/tools` — where "update yt-dlp" installs its copy.
pub fn tools_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tools")
}

pub fn app_data_ytdlp_path(data_dir: &Path) -> PathBuf {
    tools_dir(data_dir).join(Tool::Ytdlp.file_name())
}

/// `release/bin/<platform>` naming of the pack scripts.
pub fn platform_dir_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "aarch64") => "linux-arm64",
        ("linux", _) => "linux-x64",
        ("windows", _) => "windows-x64",
        ("macos", "aarch64") => "macos-arm64",
        ("macos", _) => "macos-x64",
        _ => "linux-x64",
    }
}

fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// A configured value: a path, or a bare name looked up on PATH.
fn configured_path(raw: &str) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.components().count() == 1 && !p.is_file() {
        if let Some(found) = which(raw) {
            return found;
        }
    }
    p
}

/// Bundled / development directories, in lookup order.
pub(crate) fn bundled_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push((dir.to_path_buf(), "bundled"));
            out.push((dir.join("bin"), "bundled"));
            out.push((dir.join("../resources/bin"), "bundled"));
            out.push((dir.join("resources/bin"), "bundled"));
            out.push((dir.join("../Resources/bin"), "bundled"));
        }
    }
    if let Some(dir) = env_nonempty("REKORD_TOOLS_DIR") {
        out.push((PathBuf::from(dir), "tools_dir"));
    }
    let plat = platform_dir_name();
    if cfg!(debug_assertions) {
        // crates/core → release/bin/<platform> (repository root)
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        out.push((manifest.join("../../release/bin").join(plat), "dev"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push((cwd.join("release/bin").join(plat), "dev"));
        out.push((cwd.join("../release/bin").join(plat), "dev"));
    }
    out
}

/// Candidate locations for `tool`, in priority order, deduplicated, existing only.
pub fn candidates(tool: Tool, ctx: &ToolContext) -> Vec<Candidate> {
    let name = tool.file_name();
    let mut raw: Vec<Candidate> = Vec::new();
    if tool == Tool::Ytdlp {
        if let Some(p) = &ctx.config_path {
            if let Some(s) = p.to_str() {
                raw.push(Candidate {
                    path: configured_path(s.trim()),
                    source: "config",
                });
            } else {
                raw.push(Candidate {
                    path: p.clone(),
                    source: "config",
                });
            }
        }
    }
    for key in tool.env_vars() {
        if let Some(v) = env_nonempty(key) {
            raw.push(Candidate {
                path: configured_path(&v),
                source: "env",
            });
        }
    }
    if tool == Tool::Ytdlp {
        if let Some(dir) = &ctx.data_dir {
            raw.push(Candidate {
                path: app_data_ytdlp_path(dir),
                source: "app_data",
            });
        }
    }
    for (dir, source) in bundled_dirs() {
        raw.push(Candidate {
            path: dir.join(&name),
            source,
        });
    }
    if let Some(p) = which(&name) {
        raw.push(Candidate {
            path: p,
            source: "path",
        });
    }
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .filter(|c| c.path.is_file())
        .map(|mut c| {
            // `crates/core/../../release/…` → a readable absolute path.
            if c.source == "dev" {
                if let Ok(p) = std::fs::canonicalize(&c.path) {
                    c.path = p;
                }
            }
            c
        })
        .filter(|c| {
            let key = std::fs::canonicalize(&c.path).unwrap_or_else(|_| c.path.clone());
            seen.insert(key)
        })
        .collect()
}

/// Numeric version components (`2026.08.19` → [2026, 8, 19]; `n8.1.3-14-g…`
/// → [8, 1, 3]). `None` when the text carries no number.
pub fn parse_version_numbers(text: &str) -> Option<Vec<u64>> {
    let first = text.lines().next().unwrap_or("").trim();
    let token = match first.find("version ") {
        Some(i) => first[i + "version ".len()..].split_whitespace().next(),
        None => first.split_whitespace().next(),
    }?;
    let token = token.trim_start_matches(|c: char| !c.is_ascii_digit());
    let numeric: String = token
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let nums: Vec<u64> = numeric
        .split('.')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    if nums.is_empty() {
        None
    } else {
        Some(nums)
    }
}

/// The version token shown to users (`2026.08.19`, `n8.1.3-14-g…`, `2026.9.3`).
pub fn display_version(text: &str) -> Option<String> {
    let first = text.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return None;
    }
    let token = match first.find("version ") {
        Some(i) => first[i + "version ".len()..].split_whitespace().next(),
        None => first.split_whitespace().next(),
    }?;
    Some(token.to_string())
}

/// Order two versions; missing / unparseable versions sort lowest.
pub fn compare_versions(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    let pa = a.and_then(parse_version_numbers);
    let pb = b.and_then(parse_version_numbers);
    match (pa, pb) {
        (Some(x), Some(y)) => {
            let len = x.len().max(y.len());
            for i in 0..len {
                let (xa, ya) = (
                    x.get(i).copied().unwrap_or(0),
                    y.get(i).copied().unwrap_or(0),
                );
                match xa.cmp(&ya) {
                    std::cmp::Ordering::Equal => continue,
                    o => return o,
                }
            }
            std::cmp::Ordering::Equal
        }
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

/// Release date encoded in a yt-dlp version (`2026.08.19[.123456]`).
pub fn ytdlp_release_date(version: &str) -> Option<chrono::NaiveDate> {
    let nums = parse_version_numbers(version)?;
    if nums.len() < 3 {
        return None;
    }
    chrono::NaiveDate::from_ymd_opt(
        i32::try_from(nums[0]).ok()?,
        u32::try_from(nums[1]).ok()?,
        u32::try_from(nums[2]).ok()?,
    )
}

/// Age in days of a yt-dlp release at `today`.
pub fn ytdlp_age_days(version: &str, today: chrono::NaiveDate) -> Option<i64> {
    ytdlp_release_date(version).map(|d| (today - d).num_days())
}

fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run `<path> --version` (blocking, with a timeout). `Some(text)` when the
/// binary ran and exited successfully.
pub fn probe_version_blocking(tool: Tool, path: &Path) -> Option<String> {
    probe_program_blocking(path, tool.version_args())
}

/// Run `<path> <args>` (blocking, with a timeout) and return the first output
/// line when the program ran and exited successfully.
pub(crate) fn probe_program_blocking(path: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    let line = text.lines().next().unwrap_or("").trim().to_string();
    Some(line)
}

type ProbeKey = (Tool, PathBuf, Option<std::time::SystemTime>, u64);
type ProbeCache = Mutex<HashMap<ProbeKey, (Instant, Option<String>)>>;

fn probe_cache() -> &'static ProbeCache {
    static CACHE: OnceLock<ProbeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// [`probe_version_blocking`] memoised per binary (path + mtime + size) for
/// [`VERSION_TTL`], so hubs with different contexts share probes.
pub fn probe_version_cached(tool: Tool, path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok();
    let key: ProbeKey = (
        tool,
        path.to_path_buf(),
        meta.as_ref().and_then(|m| m.modified().ok()),
        meta.as_ref().map(|m| m.len()).unwrap_or(0),
    );
    if let Ok(map) = probe_cache().lock() {
        if let Some((at, v)) = map.get(&key) {
            if at.elapsed() < VERSION_TTL {
                return v.clone();
            }
        }
    }
    let v = probe_version_blocking(tool, path);
    if let Ok(mut map) = probe_cache().lock() {
        map.insert(key, (Instant::now(), v.clone()));
    }
    v
}

/// Pick among already probed candidates: the newest version that runs;
/// ties go to the earlier (higher priority) candidate.
pub fn pick_newest(probed: &[ProbedCandidate]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, c) in probed.iter().enumerate() {
        if !c.runs {
            continue;
        }
        match best {
            None => best = Some(i),
            Some(b) => {
                if compare_versions(c.version.as_deref(), probed[b].version.as_deref())
                    == std::cmp::Ordering::Greater
                {
                    best = Some(i);
                }
            }
        }
    }
    best
}

/// Resolve from an explicit candidate list with an injectable probe (tests).
pub fn resolve_with(
    tool: Tool,
    candidates: Vec<Candidate>,
    probe: impl Fn(&Path) -> Option<String> + Sync,
) -> ResolvedTool {
    let probe = &probe;
    let probed: Vec<ProbedCandidate> = std::thread::scope(|s| {
        let handles: Vec<_> = candidates
            .iter()
            .map(|c| s.spawn(move || probe(&c.path)))
            .collect();
        candidates
            .iter()
            .zip(handles)
            .map(|(c, h)| {
                let raw = h.join().ok().flatten();
                ProbedCandidate {
                    path: c.path.clone(),
                    source: c.source,
                    runs: raw.is_some(),
                    version: raw.as_deref().and_then(display_version),
                }
            })
            .collect()
    });
    match pick_newest(&probed) {
        Some(i) => ResolvedTool {
            tool: tool.id(),
            available: true,
            path: probed[i].path.clone(),
            source: Some(probed[i].source),
            version: probed[i].version.clone(),
            candidates: probed,
            resolved_at: Some(Instant::now()),
        },
        None => ResolvedTool::missing(tool, probed),
    }
}

type CacheKey = (Tool, ToolContext);

fn cache() -> &'static Mutex<HashMap<CacheKey, ResolvedTool>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, ResolvedTool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached resolution of any age (no IO).
pub fn peek(tool: Tool, ctx: &ToolContext) -> Option<ResolvedTool> {
    let key = (tool, ctx.for_tool(tool));
    cache().lock().ok()?.get(&key).cloned()
}

fn store(tool: Tool, ctx: &ToolContext, resolved: &ResolvedTool) {
    if let Ok(mut map) = cache().lock() {
        map.insert((tool, ctx.for_tool(tool)), resolved.clone());
    }
}

/// Forget every cached resolution of `tool` (after an update).
pub fn invalidate(tool: Tool) {
    if let Ok(mut map) = cache().lock() {
        map.retain(|(t, _), _| *t != tool);
    }
    if let Ok(mut map) = probe_cache().lock() {
        map.retain(|(t, ..), _| *t != tool);
    }
}

/// Probe and pick (blocking; never call on an async worker).
pub fn resolve_blocking(tool: Tool, ctx: &ToolContext) -> ResolvedTool {
    if let Some(hit) = peek(tool, ctx).filter(ResolvedTool::is_fresh) {
        return hit;
    }
    let ctx = ctx.for_tool(tool);
    let resolved = resolve_with(tool, candidates(tool, &ctx), |p| {
        probe_version_cached(tool, p)
    });
    store(tool, &ctx, &resolved);
    resolved
}

fn async_lock(tool: Tool) -> &'static tokio::sync::Mutex<()> {
    static LOCKS: OnceLock<[tokio::sync::Mutex<()>; 4]> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| {
        [
            tokio::sync::Mutex::new(()),
            tokio::sync::Mutex::new(()),
            tokio::sync::Mutex::new(()),
            tokio::sync::Mutex::new(()),
        ]
    });
    &locks[match tool {
        Tool::Ytdlp => 0,
        Tool::Ffmpeg => 1,
        Tool::Ffprobe => 2,
        Tool::Cloudflared => 3,
    }]
}

/// Resolve on the blocking pool; concurrent callers share one probe.
pub async fn resolve(tool: Tool, ctx: &ToolContext) -> ResolvedTool {
    if let Some(hit) = peek(tool, ctx).filter(ResolvedTool::is_fresh) {
        return hit;
    }
    let _guard = async_lock(tool).lock().await;
    if let Some(hit) = peek(tool, ctx).filter(ResolvedTool::is_fresh) {
        return hit;
    }
    let ctx2 = ctx.clone();
    match tokio::task::spawn_blocking(move || resolve_blocking(tool, &ctx2)).await {
        Ok(r) => r,
        Err(_) => ResolvedTool::missing(tool, Vec::new()),
    }
}

/// Refresh the cache in the background when it is stale or empty (sync
/// callers that must not block).
pub fn spawn_refresh(tool: Tool, ctx: &ToolContext) {
    if peek(tool, ctx).is_some_and(|r| r.is_fresh()) {
        return;
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let ctx = ctx.clone();
        handle.spawn(async move {
            let _ = resolve(tool, &ctx).await;
        });
    }
}

/// Best known path without running anything: the cached choice, else the
/// first existing candidate (filesystem checks only). Starts a background
/// probe so the next call gets the newest one.
pub fn quick_path(tool: Tool, ctx: &ToolContext) -> Option<PathBuf> {
    if let Some(hit) = peek(tool, ctx) {
        if !hit.is_fresh() {
            spawn_refresh(tool, ctx);
        }
        return hit.available.then_some(hit.path);
    }
    spawn_refresh(tool, ctx);
    candidates(tool, &ctx.for_tool(tool))
        .into_iter()
        .next()
        .map(|c| c.path)
}

/// Warm the cache for every tool (hub start), off the async workers.
pub fn spawn_warmup(cfg: &AppConfig) {
    let ctx = ToolContext::from_config(cfg);
    for tool in [Tool::Ytdlp, Tool::Ffmpeg, Tool::Ffprobe, Tool::Cloudflared] {
        spawn_refresh(tool, &ctx);
    }
    crate::js_runtime::spawn_refresh();
}

/// JSON status for diagnostics (`ageDays` / `stale` for yt-dlp).
pub fn status_json(r: &ResolvedTool) -> serde_json::Value {
    let mut v = serde_json::to_value(r).unwrap_or_default();
    if r.tool == Tool::Ytdlp.id() {
        let today = chrono::Utc::now().date_naive();
        let age = r
            .version
            .as_deref()
            .and_then(|ver| ytdlp_age_days(ver, today));
        let release = r
            .version
            .as_deref()
            .and_then(ytdlp_release_date)
            .map(|d| d.to_string());
        if let Some(obj) = v.as_object_mut() {
            obj.insert("releaseDate".into(), serde_json::json!(release));
            obj.insert("ageDays".into(), serde_json::json!(age));
            obj.insert(
                "stale".into(),
                serde_json::json!(age.is_some_and(|d| d > YTDLP_STALE_DAYS)),
            );
            obj.insert("staleAfterDays".into(), serde_json::json!(YTDLP_STALE_DAYS));
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_versions() {
        assert_eq!(parse_version_numbers("2026.08.19"), Some(vec![2026, 8, 19]));
        assert_eq!(
            parse_version_numbers("2026.08.19.232423\n"),
            Some(vec![2026, 8, 19, 232423])
        );
        assert_eq!(
            parse_version_numbers("ffmpeg version n8.1.3-14-g330caae0c1 Copyright"),
            Some(vec![8, 1, 3])
        );
        assert_eq!(
            parse_version_numbers("ffmpeg version 6.1.1-3ubuntu5 Copyright"),
            Some(vec![6, 1, 1])
        );
        assert_eq!(
            parse_version_numbers("cloudflared version 2026.9.3 (built 2026-09-03)"),
            Some(vec![2026, 9, 3])
        );
        assert_eq!(parse_version_numbers("garbage"), None);
        assert_eq!(
            display_version("ffmpeg version n8.1.3-14-g330caae0c1 Copyright").as_deref(),
            Some("n8.1.3-14-g330caae0c1")
        );
    }

    #[test]
    fn newest_wins_and_ties_keep_priority() {
        let c = |path: &str, source: &'static str, v: Option<&str>| ProbedCandidate {
            path: PathBuf::from(path),
            source,
            runs: v.is_some() || path.contains("runs"),
            version: v.map(str::to_string),
        };
        let list = vec![
            c("/a", "config", Some("2026.01.31")),
            c("/b", "app_data", Some("2026.09.30")),
            c("/c", "bundled", Some("2026.09.30")),
            c("/d", "path", None),
        ];
        assert_eq!(pick_newest(&list), Some(1));
        let list = vec![
            c("/x-runs", "config", None),
            c("/y", "path", Some("2025.01.01")),
        ];
        assert_eq!(pick_newest(&list), Some(1));
        assert_eq!(pick_newest(&[c("/broken", "env", None)]), None);
    }

    #[test]
    fn ytdlp_age() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
        assert_eq!(ytdlp_age_days("2026.08.19", today), Some(47));
        assert_eq!(ytdlp_age_days("2026.01.31", today), Some(247));
        assert_eq!(ytdlp_age_days("nope", today), None);
    }
}
