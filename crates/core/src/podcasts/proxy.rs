//! Audio and artwork of configured sources, served from the hub.
//!
//! The player may route audio through Web Audio (visualizers); a
//! cross-origin `<audio>` without CORS headers then plays silence. So
//! episodes and live streams are proxied: same origin as `/media`, Range
//! passed through (seeking works), streamed chunk by chunk (never buffered),
//! every redirect hop checked against the SSRF guard. Only URLs of the
//! configured sources' episodes are reachable — the client names a source id
//! and an episode key, never a URL, so this is not an open proxy.

use super::{refresh_source, store, ytdlp_src, PodcastError, Runtime, SourceKind, LIVE_KEY};
use crate::sync::LockRecover;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::StreamExt;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Proxied streams at once (all clients).
pub const MAX_STREAMS: usize = 8;
/// A stalled upstream is dropped after this long without a byte.
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
/// Longest life of one proxied response (a client reconnects past it).
const EPISODE_MAX_LIFETIME: Duration = Duration::from_secs(4 * 3600);
const LIVE_MAX_LIFETIME: Duration = Duration::from_secs(8 * 3600);
/// Per-stream pace: a burst for the first seconds of buffering, then a cap
/// far above any audio bitrate that still keeps one client from saturating
/// the hub's uplink.
const BURST_BYTES: f64 = 4.0 * 1024.0 * 1024.0;
const RATE_BYTES_PER_SEC: f64 = 2.0 * 1024.0 * 1024.0;

struct Slot(Arc<Runtime>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.streams.fetch_sub(1, Ordering::SeqCst);
    }
}

fn take_slot(rt: &Arc<Runtime>) -> Option<Slot> {
    let before = rt.streams.fetch_add(1, Ordering::SeqCst);
    if before >= MAX_STREAMS {
        rt.streams.fetch_sub(1, Ordering::SeqCst);
        return None;
    }
    Some(Slot(rt.clone()))
}

pub fn error_response(e: &PodcastError) -> Response {
    let body = serde_json::json!({
        "ok": false,
        "data": null,
        "error": e.code(),
        "message": e.to_string(),
    });
    (e.status(), axum::Json(body)).into_response()
}

pub struct Upstream {
    pub url: String,
    pub live: bool,
    pub mime: Option<String>,
    /// Resolved by yt-dlp (a dead URL must be resolved again).
    pub resolved: bool,
}

/// Where episode `key` of source `sid` lives. Only cached episodes of
/// configured sources (or one being played) qualify.
pub async fn upstream_for(state: &AppState, sid: i64, key: &str) -> Result<Upstream, PodcastError> {
    let rt = state.podcasts.clone();
    if let Some((url, live)) = rt.playing_url(sid, key) {
        return Ok(Upstream {
            url,
            live,
            mime: None,
            resolved: false,
        });
    }
    let mut src = store::get(&state.db, sid)?.ok_or(PodcastError::SourceNotFound)?;
    if src.kind == SourceKind::Live {
        if key != LIVE_KEY {
            return Err(PodcastError::EpisodeNotFound);
        }
        rt.note_playing(sid, key, &src.feed_url, true);
        return Ok(Upstream {
            url: src.feed_url,
            live: true,
            mime: None,
            resolved: false,
        });
    }
    if !src.episodes.iter().any(|e| e.key == key) {
        // Never fetched (or the cache expired): one on-demand fetch.
        src = refresh_source(state, sid, false).await?;
    }
    let ep = src
        .episodes
        .iter()
        .find(|e| e.key == key)
        .cloned()
        .ok_or(PodcastError::EpisodeNotFound)?;
    if let Some(url) = ep.media_url.clone() {
        rt.note_playing(sid, key, &url, false);
        return Ok(Upstream {
            url,
            live: false,
            mime: ep.mime,
            resolved: false,
        });
    }
    let page = ep.page_url.clone().ok_or(PodcastError::EpisodeNotFound)?;
    let url = match rt.cached_resolution(sid, key) {
        Some(u) => u,
        None => {
            let cfg = state.config.lock_or_recover().clone();
            let page_url = super::net::parse_public_url(&page)?;
            super::net::resolve_allowed(&page_url, &rt.policy()).await?;
            let u = ytdlp_src::resolve_audio(&cfg, page_url.as_str()).await?;
            rt.remember_resolution(sid, key, &u);
            u
        }
    };
    Ok(Upstream {
        url,
        live: false,
        mime: None,
        resolved: true,
    })
}

/// Only media types leave the proxy: an upstream (or a redirect hop) that
/// answers `text/html` or `image/svg+xml` must never be served as a page of
/// the hub's own origin.
fn is_media_type(t: &str) -> bool {
    t.starts_with("audio/") || t.starts_with("video/") || t == "application/ogg"
}

/// What `<audio>` engines accept best for the upstream's content type.
fn normalize_content_type(upstream: Option<&str>, fallback: Option<&str>) -> String {
    let clean = |s: &str| {
        s.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
    };
    let raw = upstream.map(clean).filter(|s| is_media_type(s));
    let ct = raw.or_else(|| fallback.map(clean).filter(|s| is_media_type(s)));
    match ct.as_deref() {
        Some("audio/x-m4a") | Some("audio/m4a") | Some("audio/x-mp4") => "audio/mp4".into(),
        Some("audio/aacp") | Some("audio/x-aac") => "audio/aac".into(),
        Some("audio/mp3") | Some("audio/x-mp3") | Some("audio/mpeg3") => "audio/mpeg".into(),
        Some(other) => other.to_string(),
        None => "audio/mpeg".into(),
    }
}

/// Stream episode / live audio with Range pass-through.
pub async fn stream(state: &AppState, sid: i64, key: &str, req_headers: &HeaderMap) -> Response {
    let rt = state.podcasts.clone();
    let Some(slot) = take_slot(&rt) else {
        return error_response(&PodcastError::Busy);
    };
    let upstream = match upstream_for(state, sid, key).await {
        Ok(u) => u,
        Err(e) => return error_response(&e),
    };
    let url = match super::net::parse_public_url(&upstream.url) {
        Ok(u) => u,
        Err(e) => return error_response(&e),
    };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("*/*"));
    if !upstream.live {
        if let Some(range) = req_headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .filter(|r| r.trim_start().starts_with("bytes=") && r.len() < 200)
        {
            if let Ok(v) = HeaderValue::from_str(range) {
                headers.insert(reqwest::header::RANGE, v);
            }
            if let Some(ir) = req_headers.get(header::IF_RANGE) {
                headers.insert(reqwest::header::IF_RANGE, ir.clone());
            }
        }
    }
    let policy = rt.policy();
    // Host only in the log: episode URLs often carry signed tokens.
    let host = url.host_str().unwrap_or("").to_string();
    let opened = match super::net::open(super::net::Request {
        url,
        headers,
        timeout: None,
        policy: &policy,
    })
    .await
    {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!(source = sid, key, host = %host, code = e.code(), "podcast stream: upstream unreachable");
            return error_response(&e);
        }
    };
    let res = opened.response;
    let up_status = res.status().as_u16();
    if !(res.status().is_success() || up_status == 416) {
        tracing::warn!(
            source = sid,
            key,
            status = up_status,
            host = opened.final_url.host_str().unwrap_or(""),
            "podcast stream: upstream answered an error"
        );
        if upstream.resolved || matches!(up_status, 403 | 404 | 410) {
            // Expired signed URL or a dropped episode: resolve again next time.
            rt.forget_resolution(sid, key);
        }
        return error_response(&PodcastError::Http(up_status));
    }
    let status = StatusCode::from_u16(up_status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();
    let up = res.headers();
    let ct = normalize_content_type(
        up.get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        upstream.mime.as_deref(),
    );
    if let Ok(v) = HeaderValue::from_str(&ct) {
        out.insert(header::CONTENT_TYPE, v);
    }
    if !upstream.live {
        for name in [
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::LAST_MODIFIED,
            header::ETAG,
        ] {
            if let Some(v) = up.get(name.as_str()) {
                if let Ok(v) = HeaderValue::from_bytes(v.as_bytes()) {
                    out.insert(name, v);
                }
            }
        }
    } else {
        out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("none"));
    }
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    // Upstream bytes, never a document of the hub's origin.
    out.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    let lifetime = if upstream.live {
        LIVE_MAX_LIFETIME
    } else {
        EPISODE_MAX_LIFETIME
    };
    let body = Body::from_stream(paced(res.bytes_stream().boxed(), lifetime, slot));
    (status, out, body).into_response()
}

struct Pump {
    inner: futures::stream::BoxStream<'static, reqwest::Result<Bytes>>,
    started: Instant,
    deadline: Instant,
    sent: f64,
    done: bool,
    _slot: Slot,
}

/// Upstream bytes with an idle timeout, a lifetime and a pace cap. The slot
/// is released when the client goes away (the stream is dropped).
fn paced(
    inner: futures::stream::BoxStream<'static, reqwest::Result<Bytes>>,
    lifetime: Duration,
    slot: Slot,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    let now = Instant::now();
    let pump = Pump {
        inner,
        started: now,
        deadline: now + lifetime,
        sent: 0.0,
        done: false,
        _slot: slot,
    };
    futures::stream::unfold(pump, |mut p| async move {
        if p.done || Instant::now() >= p.deadline {
            return None;
        }
        let allowed = BURST_BYTES + RATE_BYTES_PER_SEC * p.started.elapsed().as_secs_f64();
        if p.sent > allowed {
            let wait = ((p.sent - allowed) / RATE_BYTES_PER_SEC).min(2.0);
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
        }
        match tokio::time::timeout(IDLE_TIMEOUT, p.inner.next()).await {
            Ok(Some(Ok(chunk))) => {
                p.sent += chunk.len() as f64;
                Some((Ok(chunk), p))
            }
            Ok(Some(Err(e))) => {
                p.done = true;
                Some((Err(std::io::Error::other(e)), p))
            }
            Ok(None) | Err(_) => None,
        }
    })
}

// ---- Artwork ---------------------------------------------------------------

/// Thumbnails kept on disk (`<data>/cache/podcast-art`), oldest dropped first.
const ART_CACHE_MAX_FILES: usize = 300;
const ART_SIZE: u32 = 400;
const ART_MAX_DOWNLOAD: usize = 12 * 1024 * 1024;

fn art_cache_dir(state: &AppState) -> std::path::PathBuf {
    state
        .config
        .lock_or_recover()
        .data_dir
        .join("cache")
        .join("podcast-art")
}

fn art_cache_name(url: &str) -> String {
    format!("{}.jpg", super::episode_key(url))
}

/// Artwork URL of an episode (its own, else the source's); `_` = the source.
fn artwork_url_for(src: &store::Source, key: &str) -> Option<String> {
    if key != "_" && key != LIVE_KEY {
        if let Some(u) = src
            .episodes
            .iter()
            .find(|e| e.key == key)
            .and_then(|e| e.artwork_url.clone())
        {
            return Some(u);
        }
    }
    src.artwork_url
        .clone()
        .or_else(|| src.episodes.iter().find_map(|e| e.artwork_url.clone()))
}

fn image_response(bytes: Vec<u8>) -> Response {
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    (StatusCode::OK, h, bytes).into_response()
}

fn art_missing() -> Response {
    let mut h = HeaderMap::new();
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    (StatusCode::NOT_FOUND, h).into_response()
}

/// A small JPEG of the artwork, made once and kept on disk.
pub async fn artwork(state: &AppState, sid: i64, key: &str) -> Response {
    let src = match store::get(&state.db, sid) {
        Ok(Some(s)) => s,
        Ok(None) => return error_response(&PodcastError::SourceNotFound),
        Err(e) => return error_response(&e),
    };
    let Some(url) = artwork_url_for(&src, key) else {
        return art_missing();
    };
    let dir = art_cache_dir(state);
    let path = dir.join(art_cache_name(&url));
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return image_response(bytes);
    }
    // Few downloads + decodes at a time: each can take tens of MB.
    let Ok(_permit) = ART_PERMITS.acquire().await else {
        return art_missing();
    };
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return image_response(bytes);
    }
    let Ok((raw, _)) = crate::metadata::artwork::fetch_public_image(&url, ART_MAX_DOWNLOAD).await
    else {
        return art_missing();
    };
    let made = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let bytes = art_thumbnail(&raw)?;
        if std::fs::create_dir_all(&dir).is_ok() {
            prune_art_cache(&dir);
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        Some(bytes)
    })
    .await
    .ok()
    .flatten();
    match made {
        Some(bytes) => image_response(bytes),
        None => art_missing(),
    }
}

static ART_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Decode an artwork with bounded size (a small file can declare a huge
/// canvas) and re-encode it as a small JPEG.
fn art_thumbnail(raw: &[u8]) -> Option<Vec<u8>> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(raw))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(ART_MAX_DIMENSION);
    limits.max_image_height = Some(ART_MAX_DIMENSION);
    limits.max_alloc = Some(ART_MAX_ALLOC);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let thumb = img.thumbnail(ART_SIZE, ART_SIZE).to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
    thumb.write_with_encoder(enc).ok()?;
    Some(out.into_inner())
}

/// Largest artwork side decoded (podcast art is 3000 px at most in practice).
const ART_MAX_DIMENSION: u32 = 8192;
/// Memory the decoder may allocate for one artwork.
const ART_MAX_ALLOC: u64 = 128 * 1024 * 1024;

fn prune_art_cache(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file()
                .then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()))
        })
        .collect();
    if files.len() < ART_CACHE_MAX_FILES {
        return;
    }
    files.sort();
    let excess = files.len() + 1 - ART_CACHE_MAX_FILES;
    for (_, p) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huge_declared_artwork_is_refused_without_decoding() {
        // A valid PNG header declaring 20000×20000: refused by the limits.
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(b"IHDR");
        ihdr.extend_from_slice(&20000u32.to_be_bytes());
        ihdr.extend_from_slice(&20000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        assert!(art_thumbnail(&png).is_none());
        // A normal small image still works.
        let img = image::RgbImage::from_pixel(600, 600, image::Rgb([10, 20, 30]));
        let mut ok = std::io::Cursor::new(Vec::new());
        img.write_to(&mut ok, image::ImageFormat::Png).unwrap();
        assert!(art_thumbnail(ok.get_ref()).is_some());
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &b in data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn content_types_engines_accept() {
        assert_eq!(
            normalize_content_type(Some("audio/x-m4a"), None),
            "audio/mp4"
        );
        assert_eq!(
            normalize_content_type(Some("audio/aacp"), None),
            "audio/aac"
        );
        assert_eq!(
            normalize_content_type(Some("application/octet-stream"), Some("audio/mpeg")),
            "audio/mpeg"
        );
        assert_eq!(normalize_content_type(None, None), "audio/mpeg");
        // Never a document type on the hub's origin.
        assert_eq!(
            normalize_content_type(Some("text/html"), None),
            "audio/mpeg"
        );
        assert_eq!(
            normalize_content_type(Some("image/svg+xml"), Some("audio/mp4")),
            "audio/mp4"
        );
        assert_eq!(
            normalize_content_type(Some("application/xhtml+xml"), Some("text/html")),
            "audio/mpeg"
        );
        assert_eq!(
            normalize_content_type(Some("audio/ogg; codecs=opus"), None),
            "audio/ogg"
        );
    }

    #[test]
    fn stream_slots_are_capped_and_released() {
        let rt = Arc::new(Runtime::new());
        let slots: Vec<Slot> = (0..MAX_STREAMS).map(|_| take_slot(&rt).unwrap()).collect();
        assert!(take_slot(&rt).is_none());
        drop(slots);
        assert_eq!(rt.streams.load(Ordering::SeqCst), 0);
        assert!(take_slot(&rt).is_some());
    }
}
