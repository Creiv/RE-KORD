//! On-the-fly transcode for cast receivers (Chromecast / Google Home) that
//! cannot decode FLAC / OGG / Opus / WAV (parity legacy `server/transcode.mjs`,
//! `ffmpegBin.mjs`).
//!
//! `GET /api/v1/transcode/{*rel_path}?format=mp3|aac` streams ffmpeg stdout
//! (mp3 320k → `audio/mpeg`, aac 256k ADTS → `audio/aac`). Path validation is
//! the same as `/media`. ffmpeg is located by [`crate::tools`] (newest of the
//! configured, bundled and PATH copies). ffmpeg is killed as soon as the client disconnects
//! (the body owns the child, `kill_on_drop`).

use crate::state::AppState;
use crate::sync::LockRecover;
use crate::tools::{self, Tool, ToolContext};
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
use tokio_util::io::ReaderStream;

/// Concurrent ffmpeg processes; more requests get 503 `transcode_busy`.
const MAX_CONCURRENT_TRANSCODES: usize = 4;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v1/transcode/{*rel_path}", get(transcode))
}

/// Locate ffmpeg (blocking: probes versions). Order: `REKORD_FFMPEG` /
/// `FFMPEG_PATH` / `REKORD_FFMPEG_BIN`, bundled copies (exe dir, `bin/`,
/// `resources/bin`, `REKORD_TOOLS_DIR`, dev `release/bin/<platform>`),
/// then `PATH`; the newest version wins (see [`crate::tools`]).
pub fn resolve_ffmpeg_path() -> Option<PathBuf> {
    let r = tools::resolve_blocking(Tool::Ffmpeg, &ToolContext::default());
    r.available.then_some(r.path)
}

/// Cached choice without running anything (health checks, sync callers);
/// falls back to the first existing candidate and refreshes in the background.
pub fn ffmpeg_path() -> Option<PathBuf> {
    tools::quick_path(Tool::Ffmpeg, &ToolContext::default())
}

pub fn ffmpeg_available() -> bool {
    ffmpeg_path().is_some()
}

fn semaphore() -> Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_TRANSCODES)))
        .clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscodeFormat {
    Mp3,
    Aac,
}

impl TranscodeFormat {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("mp3") => Some(Self::Mp3),
            Some("aac") => Some(Self::Aac),
            _ => None,
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Mp3 => "audio/mpeg",
            Self::Aac => "audio/aac",
        }
    }

    fn default_kbps(self) -> u32 {
        match self {
            Self::Mp3 => 320,
            Self::Aac => 256,
        }
    }

    /// ffmpeg arguments reading `input` and writing the stream to stdout.
    pub fn ffmpeg_args(self, input: &std::path::Path, kbps: u32) -> Vec<std::ffi::OsString> {
        let mut args: Vec<std::ffi::OsString> =
            ["-hide_banner", "-loglevel", "error", "-nostdin", "-i"]
                .iter()
                .map(Into::into)
                .collect();
        args.push(input.as_os_str().to_owned());
        let (codec, container) = match self {
            Self::Mp3 => ("libmp3lame", "mp3"),
            // ADTS is the streamable raw AAC container (`audio/aac`).
            Self::Aac => ("aac", "adts"),
        };
        for a in [
            "-vn",
            "-map_metadata",
            "-1",
            "-c:a",
            codec,
            "-b:a",
            &format!("{kbps}k"),
            "-f",
            container,
            "pipe:1",
        ] {
            args.push(a.into());
        }
        args
    }
}

#[derive(Debug, Deserialize, Default)]
struct TranscodeQuery {
    format: Option<String>,
    /// Optional kbps override, clamped to 64..=320.
    bitrate: Option<u32>,
}

fn json_err(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "data": null, "error": code })),
    )
        .into_response()
}

async fn transcode(
    State(state): State<AppState>,
    AxumPath(rel_path): AxumPath<String>,
    Query(q): Query<TranscodeQuery>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    let resolved = tools::resolve(Tool::Ffmpeg, &ToolContext::default()).await;
    if !resolved.available {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_unavailable");
    }
    let ffmpeg = resolved.path;
    if q.format
        .as_deref()
        .is_some_and(|f| f.trim().eq_ignore_ascii_case("flac"))
    {
        return transcode_cached_flac(&state, &rel_path, &ffmpeg, &method, &req_headers).await;
    }
    let Some(format) = TranscodeFormat::parse(q.format.as_deref()) else {
        return json_err(StatusCode::BAD_REQUEST, "unsupported_format");
    };
    let kbps = q
        .bitrate
        .map(|b| b.clamp(64, 320))
        .unwrap_or_else(|| format.default_kbps());
    let source = match crate::media::resolve_media_path(&state, &rel_path) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(format.content_type()),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("none"));
    if method == Method::HEAD {
        return (StatusCode::OK, headers).into_response();
    }

    let Ok(permit) = semaphore().try_acquire_owned() else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "transcode_busy");
    };
    let mut child = match tokio::process::Command::new(&ffmpeg)
        .args(format.ffmpeg_args(&source, kbps))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, ffmpeg = %ffmpeg.display(), "ffmpeg spawn failed");
            return json_err(StatusCode::SERVICE_UNAVAILABLE, "ffmpeg_unavailable");
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "ffmpeg_stdout");
    };
    // The stream owns the child and the permit: when the client goes away the
    // body is dropped, `kill_on_drop` stops ffmpeg and the slot is released.
    let guard = (child, permit);
    let stream = ReaderStream::with_capacity(stdout, 32 * 1024).map(move |chunk| {
        let _owned = &guard;
        chunk
    });
    (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
}

/// Largest size the FLAC cache may reach before the oldest files are dropped.
const FLAC_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// A whole-file conversion must finish within this (multi-hour DJ sets included).
const FLAC_CONVERT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// One conversion per source at a time; concurrent requests wait for it.
fn flac_locks(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    > = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// The player's fallback for formats the engine can't decode (WMA, AIFF, ALAC).
/// Unlike the live MP3 stream used by Cast, the file is converted once to FLAC
/// (lossless, fast: decode-bound) into `<data_dir>/cache/transcode` and served
/// like any library file, with Range: seeking, duration and resume all work.
async fn transcode_cached_flac(
    state: &AppState,
    rel_path: &str,
    ffmpeg: &std::path::Path,
    method: &Method,
    req_headers: &HeaderMap,
) -> Response {
    use sha2::{Digest, Sha256};
    let source = match crate::media::resolve_media_path(state, rel_path) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(meta) = tokio::fs::metadata(&source).await else {
        return json_err(StatusCode::NOT_FOUND, "track_not_found");
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = {
        let mut h = Sha256::new();
        h.update(source.to_string_lossy().as_bytes());
        h.update(meta.len().to_le_bytes());
        h.update(mtime.to_le_bytes());
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let dir = state
        .config
        .lock_or_recover()
        .data_dir
        .join("cache")
        .join("transcode");
    let target = dir.join(format!("{key}.flac"));
    if !target.is_file() {
        let lock = flac_locks()
            .lock_or_recover()
            .entry(key.clone())
            .or_default()
            .clone();
        let _held = lock.lock().await;
        if !target.is_file() {
            if let Err(e) = tokio::fs::create_dir_all(&dir).await {
                tracing::warn!(error = %e, "transcode cache dir");
                return json_err(StatusCode::INTERNAL_SERVER_ERROR, "transcode_failed");
            }
            let tmp = dir.join(format!("{key}.part.flac"));
            let status = tokio::time::timeout(
                FLAC_CONVERT_TIMEOUT,
                tokio::process::Command::new(ffmpeg)
                    .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
                    .arg(&source)
                    .args([
                        "-vn",
                        "-map_metadata",
                        "-1",
                        "-c:a",
                        "flac",
                        "-compression_level",
                        "0",
                    ])
                    .arg(&tmp)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .status(),
            )
            .await;
            let ok = matches!(status, Ok(Ok(s)) if s.success());
            if !ok || tokio::fs::rename(&tmp, &target).await.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
                tracing::warn!(rel = %rel_path, "flac transcode failed");
                return json_err(StatusCode::INTERNAL_SERVER_ERROR, "transcode_failed");
            }
            flac_locks().lock_or_recover().remove(&key);
            let dir_for_prune = dir.clone();
            tokio::task::spawn_blocking(move || prune_flac_cache(&dir_for_prune));
        }
    }
    crate::media::serve_file(&target, method, req_headers, Some("audio/flac")).await
}

/// Keep the cache under [`FLAC_CACHE_MAX_BYTES`], dropping least recently used files.
fn prune_flac_cache(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() || e.path().to_string_lossy().ends_with(".part.flac") {
                return None;
            }
            let used = m.accessed().or_else(|_| m.modified()).ok()?;
            Some((used, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= FLAC_CACHE_MAX_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_defaults_to_mp3() {
        assert_eq!(TranscodeFormat::parse(None), Some(TranscodeFormat::Mp3));
        assert_eq!(
            TranscodeFormat::parse(Some("AAC")),
            Some(TranscodeFormat::Aac)
        );
        assert_eq!(TranscodeFormat::parse(Some("ogg")), None);
    }

    #[test]
    fn args_stream_to_stdout() {
        let args = TranscodeFormat::Mp3.ffmpeg_args(std::path::Path::new("/x/a.flac"), 320);
        let joined: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(joined.windows(2).any(|w| w == ["-f", "mp3"]));
        assert!(joined.windows(2).any(|w| w == ["-b:a", "320k"]));
        assert_eq!(joined.last().map(String::as_str), Some("pipe:1"));
    }
}
