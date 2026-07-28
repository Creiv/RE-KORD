//! yt-dlp invocation for Studio downloads.

use crate::config::AppConfig;
use crate::path_util::{rel_path_looks_like_album_folder, safe_rel_path};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use url::Url;

const ROLL_CAP: usize = 64 * 1024;
const DONE_FIELD_MAX: usize = 12 * 1024;

const ALLOWED_HOSTS: &[&str] = &[
    "youtube.com",
    "music.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "bandcamp.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFail {
    pub label: String,
    pub reason: String,
}

pub fn resolve_ytdlp_path(cfg: &AppConfig) -> PathBuf {
    if let Some(p) = &cfg.ytdlp_path {
        return p.clone();
    }
    if let Ok(p) = std::env::var("YTDLP_PATH") {
        let t = p.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    PathBuf::from("yt-dlp")
}

pub fn ytdlp_enabled() -> bool {
    match std::env::var("ENABLE_YTDLP") {
        Ok(v) if v.trim() == "0" => false,
        _ => true,
    }
}

pub fn normalize_http_url(raw: &str) -> String {
    let s = raw.trim();
    if s.starts_with("//") {
        return format!("https:{s}");
    }
    s.to_string()
}

pub fn coerce_ytdlp_url(raw: &str) -> String {
    let s = normalize_http_url(raw);
    if s.is_empty() {
        return s;
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return s;
    }
    if s.starts_with('/') {
        return format!("https://www.youtube.com{s}");
    }
    if s.starts_with("watch?")
        || s.starts_with("playlist?")
        || s.starts_with("embed/")
        || s.starts_with("shorts/")
    {
        return format!("https://www.youtube.com/{s}");
    }
    s
}

pub fn is_allowed_ytdlp_url(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else {
        return false;
    };
    if u.scheme() != "http" && u.scheme() != "https" {
        return false;
    }
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if ALLOWED_HOSTS.iter().any(|h| host == *h) {
        return true;
    }
    ALLOWED_HOSTS.iter().any(|h| host.ends_with(&format!(".{h}")))
}

pub fn is_uuid_download_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value.trim()).is_ok()
}

fn is_probably_playlist_url(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else {
        return false;
    };
    if let Some(list) = u.query_pairs().find(|(k, _)| k == "list").map(|(_, v)| v) {
        if !list.is_empty() && list.to_ascii_uppercase() != "WL" {
            return true;
        }
    }
    u.path().contains("/playlist")
}

fn track_index_fragment(url: &str) -> &'static str {
    if is_probably_playlist_url(url) {
        "%(playlist_index)02d"
    } else {
        "%(autonumber)02d"
    }
}

fn flat_tracks_dest_kind(kind: &str) -> bool {
    matches!(
        kind,
        "download_single" | "download_playlist" | "download_ytmusic" | "download_releases"
    )
}

pub fn output_template(url: &str, download_kind: &str, output_dir: &str) -> String {
    let name = "%(track,title)s";
    if flat_tracks_dest_kind(download_kind) && rel_path_looks_like_album_folder(output_dir) {
        return format!("{} - {name}.%(ext)s", track_index_fragment(url));
    }
    let n = track_index_fragment(url);
    if let Ok(u) = Url::parse(url) {
        let host = u
            .host_str()
            .unwrap_or("")
            .trim_start_matches("www.")
            .to_ascii_lowercase();
        if host.ends_with("bandcamp.com") {
            return format!("%(album)s/{n} - {name}.%(ext)s");
        }
        let pl = is_probably_playlist_url(url);
        if host.contains("music.youtube.com") {
            if pl {
                return format!("%(album|playlist_title)s/{n} - {name}.%(ext)s");
            }
            return format!("%(album)s/{n} - {name}.%(ext)s");
        }
        if pl {
            return format!("%(playlist_title)s/{n} - {name}.%(ext)s");
        }
    }
    format!("%(title)s/{n} - {name}.%(ext)s")
}

fn javascript_args() -> Vec<String> {
    let runtime = std::env::var("REKORD_YTDLP_JS_RUNTIME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "node".into());
    let mut args = vec![
        "--js-runtimes".into(),
        if runtime.contains(':') {
            runtime
        } else {
            format!("node:{runtime}")
        },
    ];
    if let Ok(remote) = std::env::var("REKORD_YTDLP_REMOTE_COMPONENTS") {
        let t = remote.trim();
        if !t.is_empty() {
            args.push("--remote-components".into());
            args.push(t.to_string());
        }
    }
    args
}

pub fn build_download_args(
    cfg: &AppConfig,
    url: &str,
    download_kind: &str,
    output_dir: &str,
) -> Result<Vec<String>> {
    let out_dir = safe_rel_path(output_dir)?;
    let mut tmpl = output_template(url, download_kind, &out_dir);
    if !out_dir.is_empty() {
        tmpl = format!("{}/{}", out_dir.trim_end_matches('/'), tmpl.trim_start_matches('/'));
    }
    let mut args = vec![
        "-f".into(),
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio".into(),
    ];
    args.extend(javascript_args());
    if let Some(cookies) = cfg.youtube_cookies_for_ytdlp() {
        args.push("--cookies".into());
        args.push(cookies.to_string_lossy().into_owned());
    }
    args.push("-o".into());
    args.push(tmpl);
    if download_kind == "download_single" {
        args.push("--no-playlist".into());
    }
    args.push(url.to_string());
    Ok(args)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(x) = chars.next() {
                    if x.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

pub fn extract_last_item_progress(text: &str) -> Option<(u32, u32)> {
    let clean = strip_ansi(text);
    let mut last = None;
    let needle = "Downloading item ";
    for line in clean.lines() {
        if let Some(idx) = line.find(needle) {
            let rest = &line[idx + needle.len()..];
            let mut parts = rest.split_whitespace();
            let cur = parts.next()?.parse::<u32>().ok()?;
            if parts.next()?.eq_ignore_ascii_case("of") {
                let total = parts.next()?.parse::<u32>().ok()?;
                last = Some((cur, total));
            }
        }
    }
    last
}

struct RollLog {
    buffer: String,
    total_chars: usize,
}

impl RollLog {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            total_chars: 0,
        }
    }
    fn append(&mut self, chunk: &str) {
        self.total_chars += chunk.len();
        self.buffer.push_str(chunk);
        if self.buffer.len() > ROLL_CAP {
            self.buffer = self.buffer[self.buffer.len() - ROLL_CAP..].to_string();
        }
    }
    fn trim_for_done(&self) -> (String, bool, usize) {
        let s = &self.buffer;
        let truncated = self.total_chars > DONE_FIELD_MAX;
        if s.len() <= DONE_FIELD_MAX {
            return (s.clone(), truncated, self.total_chars);
        }
        let head = DONE_FIELD_MAX / 2 - 48;
        let tail = DONE_FIELD_MAX / 2 - 48;
        (
            format!(
                "{}\n… [truncated stdout/stderr preview] …\n{}",
                &s[..head.max(0)],
                &s[s.len().saturating_sub(tail.max(0))..]
            ),
            true,
            self.total_chars,
        )
    }
}

pub fn item_summary_from_log(stdout: &str, stderr: &str) -> (Vec<String>, Vec<ItemFail>, Vec<ItemFail>) {
    let raw = format!("{stderr}\n{stdout}");
    let mut downloaded = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut seen_d = std::collections::HashSet::new();
    let mut seen_s = std::collections::HashSet::new();
    let mut seen_f = std::collections::HashSet::new();
    for line0 in raw.lines() {
        let line = line0.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("[download] Destination:") {
            let s = rest.trim().to_string();
            if !s.is_empty() && seen_d.insert(s.clone()) {
                downloaded.push(s);
            }
            continue;
        }
        if let Some(idx) = line.find(" has already been downloaded") {
            if let Some(rest) = line.strip_prefix("[download] ") {
                let s = rest[..idx.saturating_sub("[download] ".len()).min(rest.len())]
                    .trim()
                    .to_string();
                let label = if s.is_empty() {
                    rest.trim().to_string()
                } else {
                    s
                };
                let key = format!("{label}\0already");
                if seen_s.insert(key) {
                    skipped.push(ItemFail {
                        label,
                        reason: "already downloaded".into(),
                    });
                }
            }
            continue;
        }
        if line.starts_with("ERROR:")
            || line.starts_with("WARNING:")
            || line.to_ascii_lowercase().contains("unavailable")
            || line.to_ascii_lowercase().contains("private")
        {
            let label = line
                .trim_start_matches("ERROR:")
                .trim_start_matches("WARNING:")
                .trim()
                .to_string();
            let key = format!("{label}\0{line}");
            if seen_f.insert(key) {
                failed.push(ItemFail {
                    label: if label.is_empty() {
                        "unknown item".into()
                    } else {
                        label
                    },
                    reason: line.to_string(),
                });
            }
        }
    }
    (downloaded, skipped, failed)
}

pub async fn run_json_probe(cfg: &AppConfig, url: &str, timeout_ms: u64) -> Result<Value> {
    let program = resolve_ytdlp_path(cfg);
    let mut args = vec![
        "-J".into(),
        "--flat-playlist".into(),
        "--no-download".into(),
        "--no-warnings".into(),
    ];
    args.extend(javascript_args());
    if let Some(cookies) = cfg.youtube_cookies_for_ytdlp() {
        args.push("--cookies".into());
        args.push(cookies.to_string_lossy().into_owned());
    }
    args.push(url.to_string());
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().with_context(|| format!("spawn {}", program.display()))?;
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait_with_output(),
    )
    .await
    .context("yt-dlp probe timeout")?
    .context("yt-dlp probe")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ytdlp_json(&stdout).context("parse yt-dlp JSON")
}

pub fn parse_ytdlp_json(stdout: &str) -> Result<Value> {
    let t = stdout.trim();
    if t.is_empty() {
        bail!("empty yt-dlp JSON");
    }
    // yt-dlp may emit multiple JSON objects; take the largest/last object-looking chunk.
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Ok(v);
    }
    if let Some(start) = t.find('{') {
        if let Some(end) = t.rfind('}') {
            if end > start {
                return Ok(serde_json::from_str(&t[start..=end])?);
            }
        }
    }
    bail!("invalid yt-dlp JSON")
}

pub fn playlist_track_count(data: &Value) -> Option<u64> {
    if data.get("_type").and_then(|v| v.as_str()) == Some("video") {
        return Some(1);
    }
    if let Some(n) = data.get("playlist_count").and_then(|v| v.as_u64()) {
        return Some(n);
    }
    data.get("entries")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u64)
}

/// Lines of NDJSON pushed to the channel (already newline-terminated JSON).
pub type NdjsonTx = mpsc::Sender<String>;

pub async fn run_download_ndjson(
    cfg: AppConfig,
    music_root: PathBuf,
    url: String,
    download_kind: String,
    output_dir: String,
    cancel: Arc<AtomicBool>,
    tx: NdjsonTx,
) -> Result<()> {
    let _ = tx.send(r#"{"type":"started"}"#.into()).await;
    let program = resolve_ytdlp_path(&cfg);
    let args = build_download_args(&cfg, &url, &download_kind, &output_dir)?;
    let display_cmd = format!(
        "{} {} …",
        program.display(),
        args.iter()
            .take(args.len().saturating_sub(1))
            .map(|a| if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&music_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("FORCE_COLOR", "0");

    let mut child = cmd.spawn().with_context(|| format!("spawn {}", program.display()))?;
    let child_pid = child.id();
    let stdout = child.stdout.take().context("stdout")?;
    let stderr = child.stderr.take().context("stderr")?;

    let (prog_tx, mut prog_rx) = mpsc::channel::<(u32, u32)>(8);
    let (log_tx, mut log_rx) = mpsc::channel::<(bool, String)>(64);

    let prog_tx_o = prog_tx.clone();
    let log_tx_o = log_tx.clone();
    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut buf = String::new();
        while let Ok(Some(l)) = reader.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
            if buf.len() > ROLL_CAP {
                buf = buf[buf.len() - ROLL_CAP..].to_string();
            }
            if let Some(p) = extract_last_item_progress(&buf) {
                let _ = prog_tx_o.send(p).await;
            }
            let _ = log_tx_o.send((true, format!("{l}\n"))).await;
        }
    });
    let prog_tx_e = prog_tx;
    let log_tx_e = log_tx;
    let err_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(l)) = reader.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
            if buf.len() > ROLL_CAP {
                buf = buf[buf.len() - ROLL_CAP..].to_string();
            }
            if let Some(p) = extract_last_item_progress(&buf) {
                let _ = prog_tx_e.send(p).await;
            }
            let _ = log_tx_e.send((false, format!("{l}\n"))).await;
        }
    });

    // Cancel watcher kills by PID so it doesn't fight child.wait() borrow.
    let cancel_watch = cancel.clone();
    tokio::spawn(async move {
        while !cancel_watch.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        if let Some(pid) = child_pid {
            let _ = tokio::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .await;
        }
    });

    let mut out_log = RollLog::new();
    let mut err_log = RollLog::new();
    let mut last_progress: Option<(u32, u32)> = None;
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut exit_code: Option<i32> = None;

    while exit_code.is_none() {
        tokio::select! {
            status = child.wait() => {
                exit_code = Some(status.ok().and_then(|s| s.code()).unwrap_or(-1));
            }
            _ = keepalive.tick() => {
                let _ = tx.send(r#"{"type":"keepalive"}"#.into()).await;
            }
            p = prog_rx.recv() => {
                if let Some(p) = p {
                    if last_progress != Some(p) {
                        last_progress = Some(p);
                        let _ = tx.send(format!(
                            r#"{{"type":"progress","progress":{{"current":{},"total":{}}}}}"#,
                            p.0, p.1
                        )).await;
                    }
                }
            }
            chunk = log_rx.recv() => {
                if let Some((is_out, s)) = chunk {
                    if is_out { out_log.append(&s); } else { err_log.append(&s); }
                }
            }
        }
    }
    // Drain remaining logs briefly.
    let drain_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(300);
    while tokio::time::Instant::now() < drain_deadline {
        match log_rx.try_recv() {
            Ok((is_out, s)) => {
                if is_out { out_log.append(&s); } else { err_log.append(&s); }
            }
            Err(_) => break,
        }
    }
    let _ = out_task.await;
    let _ = err_task.await;

    let cancelled = cancel.load(Ordering::SeqCst);
    let code = exit_code.unwrap_or(-1);
    let (stdout_text, log_trunc_o, stdout_total) = out_log.trim_for_done();
    let (stderr_text, log_trunc_e, stderr_total) = err_log.trim_for_done();
    let (downloaded, skipped, failed) = item_summary_from_log(&stdout_text, &stderr_text);
    let ok = code == 0 && !cancelled;
    let progress = last_progress.map(|(c, t)| serde_json::json!({"current": c, "total": t}));
    let items = serde_json::json!({
        "type": "items",
        "downloadedItems": downloaded,
        "skippedItems": skipped,
        "failedItems": failed,
    });
    let _ = tx.send(items.to_string()).await;
    let done = serde_json::json!({
        "type": "done",
        "ok": ok,
        "cancelled": cancelled,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "logTruncated": log_trunc_o || log_trunc_e,
        "stdoutTotalChars": stdout_total,
        "stderrTotalChars": stderr_total,
        "code": code,
        "progress": progress,
        "musicRoot": music_root.to_string_lossy(),
        "command": display_cmd,
        "outputDir": output_dir,
        "downloadedItems": downloaded,
        "skippedItems": skipped,
        "failedItems": failed,
    });
    let _ = tx.send(done.to_string()).await;
    Ok(())
}

pub fn guess_youtube_url_from_entry_id(id: &str) -> String {
    let s = id.trim();
    if s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return format!("https://www.youtube.com/watch?v={s}");
    }
    if s.starts_with("PL")
        || s.starts_with("OLAK5uy_")
        || s.starts_with("UU")
        || s.starts_with("FL")
        || s.starts_with("RD")
        || s.starts_with("WL")
        || s.starts_with("LL")
        || s.starts_with("LM")
    {
        return format!("https://www.youtube.com/playlist?list={s}");
    }
    String::new()
}

pub fn pick_flat_entry_url(e: &Value) -> String {
    for key in ["url", "webpage_url", "original_url"] {
        if let Some(s) = e.get(key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return coerce_ytdlp_url(t);
            }
        }
    }
    String::new()
}

/// Ensure cwd exists.
pub fn ensure_music_root(root: &Path) -> Result<()> {
    if !root.is_dir() {
        bail!("music_root missing");
    }
    Ok(())
}
