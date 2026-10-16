//! Pages without a feed that yt-dlp understands (YouTube channels and
//! playlists, many broadcaster sites): list the latest entries with
//! `--flat-playlist`, resolve the audio URL only when one is played.

use super::{episode_key, Episode, PodcastError};
use crate::config::AppConfig;
use crate::ytdlp::{classify_ytdlp_error, javascript_args, ytdlp_program};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const LIST_TIMEOUT: Duration = Duration::from_secs(40);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(40);
/// yt-dlp prints one JSON document; a cap keeps a runaway answer in check.
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

async fn run(
    cfg: &AppConfig,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Vec<u8>, PodcastError> {
    if !crate::ytdlp::ytdlp_enabled() {
        return Err(PodcastError::YtdlpDisabled);
    }
    let program = ytdlp_program(cfg).await;
    // YouTube channels need the same cookies as Studio: a private copy per
    // run, removed when `cookies` drops (after the process has exited).
    let cookies = crate::ytdlp_cookies::YtdlpCookies::prepare(cfg);
    let args = args_with_cookies(args, cookies.as_ref().map(|c| c.path()));
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(PodcastError::YtdlpNotFound)
        }
        Err(e) => return Err(PodcastError::Ytdlp("ytdlp_failed", e.to_string())),
    };
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(PodcastError::Ytdlp("ytdlp_failed", e.to_string())),
        Err(_) => return Err(PodcastError::Timeout),
    };
    if output.status.success() && !output.stdout.is_empty() && output.stdout.len() <= MAX_JSON_BYTES
    {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("ERROR:"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("yt-dlp failed")
        .trim()
        .to_string();
    if detail.contains("Unsupported URL") {
        return Err(PodcastError::Unsupported);
    }
    let code = match classify_ytdlp_error(&detail) {
        "unknown" => "ytdlp_failed",
        c => c,
    };
    Err(PodcastError::Ytdlp(code, detail))
}

/// `--cookies <file>` in front: the page URL follows `--`, options go before it.
fn args_with_cookies(args: Vec<String>, cookies: Option<&Path>) -> Vec<String> {
    match cookies {
        Some(p) => {
            let mut out = vec!["--cookies".to_string(), p.to_string_lossy().into_owned()];
            out.extend(args);
            out
        }
        None => args,
    }
}

fn common_args() -> Vec<String> {
    let mut args = vec!["--no-warnings".to_string(), "--ignore-config".to_string()];
    args.extend(javascript_args());
    args
}

/// Title and latest entries of a page (`--flat-playlist -J --playlist-end N`).
pub async fn list(
    cfg: &AppConfig,
    page_url: &str,
    limit: u32,
) -> Result<(Option<String>, Vec<Episode>), PodcastError> {
    let mut args = common_args();
    args.extend([
        "--flat-playlist".into(),
        "-J".into(),
        "--playlist-end".into(),
        limit.max(1).to_string(),
        "--".into(),
        page_url.to_string(),
    ]);
    let out = run(cfg, args, LIST_TIMEOUT).await?;
    let json: Value =
        serde_json::from_slice(&out).map_err(|e| PodcastError::Parse(e.to_string()))?;
    let parsed = parse_listing(&json, page_url, limit as usize);
    if parsed.1.is_empty() {
        return Err(PodcastError::NoEpisodes);
    }
    Ok(parsed)
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn entry_date(e: &Value) -> Option<String> {
    if let Some(ts) = e
        .get("timestamp")
        .or_else(|| e.get("release_timestamp"))
        .and_then(Value::as_f64)
    {
        let d = chrono::DateTime::from_timestamp(ts as i64, 0)?;
        return Some(d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    let raw = str_of(e, "upload_date").or_else(|| str_of(e, "release_date"))?;
    let d = chrono::NaiveDate::parse_from_str(raw, "%Y%m%d").ok()?;
    Some(format!("{}T00:00:00Z", d.format("%Y-%m-%d")))
}

fn entry_thumb(e: &Value) -> Option<String> {
    if let Some(t) = str_of(e, "thumbnail") {
        return Some(t.to_string());
    }
    e.get("thumbnails")?
        .as_array()?
        .iter()
        .rev()
        .find_map(|t| str_of(t, "url").map(str::to_string))
}

/// Entries of a yt-dlp JSON answer (a playlist, or a single item).
pub fn parse_listing(json: &Value, page_url: &str, limit: usize) -> (Option<String>, Vec<Episode>) {
    let title = str_of(json, "title")
        .or_else(|| str_of(json, "playlist_title"))
        .or_else(|| str_of(json, "uploader"))
        .map(str::to_string);
    let entries: Vec<Value> = match json.get("entries").and_then(Value::as_array) {
        Some(list) => list.clone(),
        None => vec![json.clone()],
    };
    let mut out = Vec::new();
    for e in entries.iter().take(limit) {
        let url = str_of(e, "webpage_url")
            .or_else(|| str_of(e, "url"))
            .or_else(|| (entries.len() == 1).then_some(page_url));
        let Some(url) = url.filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        else {
            continue;
        };
        let id = str_of(e, "id").unwrap_or(url);
        let duration_secs = e
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| d.is_finite() && *d >= 1.0)
            .map(|d| d.round() as u32);
        out.push(Episode {
            key: episode_key(&format!("ytdlp:{id}")),
            title: str_of(e, "title").unwrap_or(id).to_string(),
            published_at: entry_date(e),
            duration_secs,
            media_url: None,
            page_url: Some(url.to_string()),
            artwork_url: entry_thumb(e),
            mime: None,
        });
    }
    (title, out)
}

/// Direct audio URL of one entry (short-lived; the caller caches it briefly).
pub async fn resolve_audio(cfg: &AppConfig, page_url: &str) -> Result<String, PodcastError> {
    let mut args = common_args();
    args.extend([
        "-g".into(),
        "-f".into(),
        "bestaudio[acodec^=mp4a]/bestaudio/best".into(),
        "--no-playlist".into(),
        "--".into(),
        page_url.to_string(),
    ]);
    let out = run(cfg, args, RESOLVE_TIMEOUT).await?;
    let text = String::from_utf8_lossy(&out);
    text.lines()
        .map(str::trim)
        .find(|l| l.starts_with("http://") || l.starts_with("https://"))
        .map(str::to_string)
        .ok_or(PodcastError::Resolve)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_go_before_the_url_separator() {
        let mut args = common_args();
        args.extend([
            "-J".into(),
            "--".into(),
            "https://www.youtube.com/@c".into(),
        ]);
        let plain = args_with_cookies(args.clone(), None);
        assert_eq!(plain, args);
        let jar = Path::new("/data/tmp/ytdlp-cookies/cookies-1.txt");
        let with = args_with_cookies(args.clone(), Some(jar));
        let at = with.iter().position(|a| a == "--cookies").unwrap();
        let sep = with.iter().position(|a| a == "--").unwrap();
        assert!(at < sep);
        assert_eq!(with[at + 1], jar.to_string_lossy());
        assert_eq!(
            with.last().map(String::as_str),
            Some("https://www.youtube.com/@c")
        );
    }

    #[test]
    fn parses_flat_playlists_and_single_items() {
        let json = serde_json::json!({
            "_type": "playlist", "title": "Channel",
            "entries": [
                { "id": "a1", "title": "First", "url": "https://www.youtube.com/watch?v=a1", "duration": 125.4, "upload_date": "20261006" },
                { "id": "b2", "title": "Second", "url": "https://www.youtube.com/watch?v=b2", "timestamp": 1791378000 },
                { "id": "c3", "title": "No url" }
            ]
        });
        let (title, eps) = parse_listing(&json, "https://www.youtube.com/@c", 5);
        assert_eq!(title.as_deref(), Some("Channel"));
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[0].duration_secs, Some(125));
        assert_eq!(eps[0].published_at.as_deref(), Some("2026-10-06T00:00:00Z"));
        assert!(eps[1].published_at.is_some());
        assert!(eps
            .iter()
            .all(|e| e.media_url.is_none() && e.page_url.is_some()));
        let single = serde_json::json!({ "id": "x", "title": "One", "duration": 60 });
        let (_, eps) = parse_listing(&single, "https://example.com/ep/1", 3);
        assert_eq!(eps[0].page_url.as_deref(), Some("https://example.com/ep/1"));
    }
}
