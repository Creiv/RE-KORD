//! Audio file streaming (`/media/*`, `/api/v1/media/*`).
//!
//! Files are streamed from disk (never buffered whole) with single-range
//! support, `HEAD`, and `ETag` / `Last-Modified` validators.
//!
//! VBR MP3s without a Xing/VBRI header (long DJ-set rips) are served with the
//! synthetic Xing frame the scan built for them spliced in front of the first
//! MPEG frame: players then know the exact length and seek by its table of
//! contents instead of extrapolating the first frame's bitrate. The file on
//! disk is never touched.

use crate::path_util::{ensure_servable, resolve_library_file, LibraryPathError};
use crate::state::AppState;
use crate::sync::LockRecover;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use futures::stream::{self, BoxStream, StreamExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/media/{*path}", get(serve_media))
        .route("/api/v1/media/{*path}", get(serve_media))
}

/// Resolve a client rel path to a servable library file.
///
/// The DB lookup comes first (indexed tracks); the direct fallback goes through
/// `resolve_library_file` (no `..`, reserved or hidden segments, symlinks
/// resolved and kept under the music root, hub data dir refused).
#[allow(clippy::result_large_err)]
pub fn resolve_media_path(state: &AppState, raw: &str) -> Result<PathBuf, Response> {
    let (root, data_dir) = {
        let cfg = state.config.lock_or_recover();
        (cfg.music_root.clone(), cfg.data_dir.clone())
    };
    let Some(root) = root else {
        return Err((StatusCode::NOT_FOUND, "track not found").into_response());
    };
    let rel = raw.trim_start_matches('/');
    if rel.contains('\0') || rel.replace('\\', "/").split('/').any(|s| s == "..") {
        return Err((StatusCode::NOT_FOUND, "track not found").into_response());
    }
    let indexed = match state.db.track_file_path_by_rel(rel) {
        Ok(p) => p,
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()),
    };
    let resolved = match indexed {
        Some(p) => ensure_servable(&root, Some(&data_dir), &p)
            .map(|_| p)
            .or_else(|_| resolve_library_file(&root, Some(&data_dir), rel)),
        None => resolve_library_file(&root, Some(&data_dir), rel),
    };
    match resolved {
        Ok(p) => Ok(p),
        Err(LibraryPathError::Invalid) | Err(LibraryPathError::NotFound) => {
            Err((StatusCode::NOT_FOUND, "track not found").into_response())
        }
    }
}

async fn serve_media(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let file_path = match resolve_media_path(&state, &path) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let splice = mp3_splice(&state, &path, &file_path).await;
    serve_file_spliced(&file_path, &method, &headers, None, splice).await
}

/// Bytes served in the middle of a file that does not contain them.
#[derive(Debug, Clone)]
pub struct Splice {
    /// File offset the bytes go in front of.
    pub at: u64,
    pub bytes: Bytes,
}

/// The scan's synthetic Xing frame for `rel`, while the file is unchanged.
async fn mp3_splice(state: &AppState, rel: &str, path: &Path) -> Option<Splice> {
    let is_mp3 = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if !is_mp3 {
        return None;
    }
    let row = state
        .db
        .mp3_seek_header(rel.trim_start_matches('/'))
        .ok()??;
    let meta = tokio::fs::metadata(path).await.ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    (meta.len() == row.size && mtime == row.mtime && row.insert_at <= row.size).then(|| Splice {
        at: row.insert_at,
        bytes: Bytes::from(row.frame),
    })
}

/// Content type of a library file. `.m4a` is `audio/mp4` (mime_guess says
/// `audio/m4a`, which browsers do not recognise for `<audio>`).
pub fn audio_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("m4a") | Some("m4b") | Some("mp4a") => "audio/mp4".into(),
        Some("aac") => "audio/aac".into(),
        Some("opus") => "audio/ogg".into(),
        Some("flac") => "audio/flac".into(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    }
}

/// Validators for a file: weak-free ETag from size + mtime, HTTP date.
fn validators(meta: &std::fs::Metadata) -> (String, Option<String>) {
    let mtime = meta.modified().ok();
    let (secs, nanos) = mtime
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| (d.as_secs(), d.subsec_nanos()))
        .unwrap_or((0, 0));
    let etag = format!("\"{:x}-{:x}-{:x}\"", meta.len(), secs, nanos);
    let last_modified = mtime.map(http_date);
    (etag, last_modified)
}

fn http_date(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

fn parse_http_date(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc2822(raw.trim())
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
}

fn etag_matches(list: &str, etag: &str) -> bool {
    list.split(',').any(|t| {
        let t = t.trim();
        t == "*" || t.trim_start_matches("W/") == etag
    })
}

/// Outcome of parsing a `Range` header against a file length.
#[derive(Debug, PartialEq, Eq)]
pub enum RangeSpec {
    /// No usable range (absent, multi-range, unknown unit): serve 200 full.
    Full,
    /// Inclusive byte range.
    Single(u64, u64),
    /// Syntactically valid but outside the file: 416.
    Unsatisfiable,
}

pub fn parse_range(header: &str, file_len: u64) -> RangeSpec {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return RangeSpec::Full;
    };
    if spec.contains(',') {
        // Multi-range: answering 200 with the whole body is always allowed.
        return RangeSpec::Full;
    }
    let Some((start_s, end_s)) = spec.trim().split_once('-') else {
        return RangeSpec::Full;
    };
    let (start_s, end_s) = (start_s.trim(), end_s.trim());
    if start_s.is_empty() {
        // suffix: bytes=-N
        let Ok(suffix) = end_s.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if suffix == 0 || file_len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        return RangeSpec::Single(file_len.saturating_sub(suffix), file_len - 1);
    }
    let Ok(start) = start_s.parse::<u64>() else {
        return RangeSpec::Full;
    };
    if start >= file_len {
        return RangeSpec::Unsatisfiable;
    }
    let end = if end_s.is_empty() {
        file_len - 1
    } else {
        match end_s.parse::<u64>() {
            Ok(e) => e.min(file_len - 1),
            Err(_) => return RangeSpec::Full,
        }
    };
    if end < start {
        return RangeSpec::Full;
    }
    RangeSpec::Single(start, end)
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Stream `path` honouring Range / If-None-Match / If-Modified-Since / If-Range.
/// `content_type` overrides the extension-based guess.
pub async fn serve_file(
    path: &Path,
    method: &Method,
    req_headers: &HeaderMap,
    content_type: Option<&str>,
) -> Response {
    serve_file_spliced(path, method, req_headers, content_type, None).await
}

/// [`serve_file`] of the file with `splice` inserted: ranges, length and
/// validators all describe the spliced stream.
pub async fn serve_file_spliced(
    path: &Path,
    method: &Method,
    req_headers: &HeaderMap,
    content_type: Option<&str>,
    splice: Option<Splice>,
) -> Response {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m,
        _ => return (StatusCode::NOT_FOUND, "file missing").into_response(),
    };
    let disk_len = meta.len();
    let splice = splice.filter(|s| s.at <= disk_len && !s.bytes.is_empty());
    let file_len = disk_len + splice.as_ref().map_or(0, |s| s.bytes.len() as u64);
    let mime = content_type
        .map(str::to_string)
        .unwrap_or_else(|| audio_mime(path));
    let (mut etag, last_modified) = validators(&meta);
    if let Some(s) = &splice {
        // Another representation of the same file: never mix ranges of both.
        etag.insert_str(etag.len() - 1, &format!("-x{:x}", s.bytes.len()));
    }

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    // Library files change rarely and carry validators: let the browser keep
    // them (private: they are behind the account / access checks).
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000"),
    );
    // Library folders hold whatever came with an album (`.html`, `.svg`, …).
    // Opened directly from the hub origin such a file would run script that
    // counts as same-origin (and local) and could drive machine operations;
    // a sandboxed, script-less document gets an opaque origin instead.
    // `<audio>` / `<img>` subresources are unaffected.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    if let Ok(v) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, v);
    }
    if let Some(lm) = last_modified
        .as_deref()
        .and_then(|s| HeaderValue::from_str(s).ok())
    {
        headers.insert(header::LAST_MODIFIED, lm);
    }

    // Conditional GET: If-None-Match wins over If-Modified-Since.
    let not_modified = if let Some(inm) = header_str(req_headers, header::IF_NONE_MATCH) {
        etag_matches(inm, &etag)
    } else if let (Some(ims), Some(lm)) = (
        header_str(req_headers, header::IF_MODIFIED_SINCE).and_then(parse_http_date),
        last_modified.as_deref().and_then(parse_http_date),
    ) {
        lm <= ims
    } else {
        false
    };
    if not_modified {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }

    // If-Range: only honour Range when the validator still matches.
    let range_allowed = match header_str(req_headers, header::IF_RANGE) {
        None => true,
        Some(v) if v.trim().starts_with('"') || v.trim().starts_with("W/") => v.trim() == etag,
        Some(v) => match (
            parse_http_date(v),
            last_modified.as_deref().and_then(parse_http_date),
        ) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        },
    };
    let range = match header_str(req_headers, header::RANGE) {
        Some(r) if range_allowed => parse_range(r, file_len),
        _ => RangeSpec::Full,
    };

    let (status, start, len) = match range {
        RangeSpec::Full => (StatusCode::OK, 0, file_len),
        RangeSpec::Single(start, end) => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{file_len}")) {
                headers.insert(header::CONTENT_RANGE, v);
            }
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        RangeSpec::Unsatisfiable => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{file_len}")) {
                headers.insert(header::CONTENT_RANGE, v);
            }
            headers.remove(header::CONTENT_TYPE);
            return (StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response();
        }
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));

    if *method == Method::HEAD {
        return (status, headers, Body::empty()).into_response();
    }

    let parts = match &splice {
        None => vec![Part::File { start, len }],
        Some(s) => spliced_parts(start, len, s),
    };
    let mut streams: Vec<BoxStream<'static, std::io::Result<Bytes>>> = Vec::new();
    for part in parts {
        match part {
            Part::File { start, len } => match file_range(path, start, len).await {
                Ok(s) => streams.push(s),
                Err(r) => return r,
            },
            Part::Bytes(b) => streams.push(stream::once(async move { Ok(b) }).boxed()),
        }
    }
    let body = match streams.len() {
        1 => Body::from_stream(streams.pop().unwrap()),
        _ => Body::from_stream(stream::iter(streams).flatten()),
    };
    (status, headers, body).into_response()
}

#[derive(Debug, PartialEq, Eq)]
enum Part {
    File { start: u64, len: u64 },
    Bytes(Bytes),
}

/// The pieces of `[start, start + len)` of the spliced stream: file bytes
/// before the insertion point, the inserted bytes, file bytes after it.
fn spliced_parts(start: u64, len: u64, splice: &Splice) -> Vec<Part> {
    let (at, n) = (splice.at, splice.bytes.len() as u64);
    let end = start + len;
    let mut parts = Vec::new();
    if start < at {
        parts.push(Part::File {
            start,
            len: end.min(at) - start,
        });
    }
    let (b0, b1) = (start.max(at), end.min(at + n));
    if b0 < b1 {
        parts.push(Part::Bytes(
            splice.bytes.slice((b0 - at) as usize..(b1 - at) as usize),
        ));
    }
    if end > at + n {
        let from = start.max(at + n) - n;
        parts.push(Part::File {
            start: from,
            len: end - n - from,
        });
    }
    parts
}

// The error is an axum `Response` handed straight back to the client.
#[allow(clippy::result_large_err)]
async fn file_range(
    path: &Path,
    start: u64,
    len: u64,
) -> Result<BoxStream<'static, std::io::Result<Bytes>>, Response> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "open error").into_response()),
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response());
    }
    Ok(ReaderStream::with_capacity(file.take(len), 64 * 1024).boxed())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), RangeSpec::Single(0, 9));
        assert_eq!(parse_range("bytes=90-", 100), RangeSpec::Single(90, 99));
        assert_eq!(parse_range("bytes=-10", 100), RangeSpec::Single(90, 99));
        assert_eq!(parse_range("bytes=-500", 100), RangeSpec::Single(0, 99));
        assert_eq!(parse_range("bytes=0-500", 100), RangeSpec::Single(0, 99));
        assert_eq!(parse_range("bytes=100-", 100), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), RangeSpec::Full);
        assert_eq!(parse_range("items=0-1", 100), RangeSpec::Full);
    }

    fn file(start: u64, len: u64) -> Part {
        Part::File { start, len }
    }

    #[test]
    fn splits_ranges_around_a_splice() {
        // File of 100 bytes, 10 bytes inserted at 40: stream of 110.
        let s = Splice {
            at: 40,
            bytes: Bytes::from_static(b"0123456789"),
        };
        let b = |x: &'static [u8]| Part::Bytes(Bytes::from_static(x));
        assert_eq!(
            spliced_parts(0, 110, &s),
            vec![file(0, 40), b(b"0123456789"), file(40, 60)]
        );
        assert_eq!(spliced_parts(0, 40, &s), vec![file(0, 40)]);
        assert_eq!(spliced_parts(38, 4, &s), vec![file(38, 2), b(b"01")]);
        assert_eq!(spliced_parts(45, 2, &s), vec![b(b"56")]);
        assert_eq!(spliced_parts(48, 5, &s), vec![b(b"89"), file(40, 3)]);
        assert_eq!(spliced_parts(50, 60, &s), vec![file(40, 60)]);
        assert_eq!(spliced_parts(109, 1, &s), vec![file(99, 1)]);
        // Inserted at the very start (no ID3 tag).
        let s0 = Splice { at: 0, ..s };
        assert_eq!(
            spliced_parts(0, 12, &s0),
            vec![b(b"0123456789"), file(0, 2)]
        );
    }
}
