use crate::state::AppState;
use crate::sync::LockRecover;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::path::{Path as FsPath, PathBuf};
use tokio_util::io::ReaderStream;

pub const COVER_BASENAMES: &[&str] = &[
    "cover.jpg",
    "folder.jpg",
    "front.jpg",
    "cover.png",
    "folder.png",
    "artwork.jpg",
    "Cover.jpg",
    "Folder.jpg",
];

pub fn find_cover_in_dir(dir: &FsPath) -> Option<PathBuf> {
    for name in COVER_BASENAMES {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // case-insensitive scan for a few names
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    let wanted: Vec<String> = COVER_BASENAMES
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if wanted.iter().any(|w| w == &name.to_ascii_lowercase()) {
            return Some(path);
        }
    }
    None
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/covers/album/{id}", get(album_cover))
        .route("/api/v1/covers/artist/{id}", get(artist_cover))
}

#[derive(Debug, Deserialize, Default)]
pub struct CoverQuery {
    /// Requested edge in pixels; snapped to a cached thumbnail bucket.
    pub size: Option<u32>,
    /// Cache-busting version (`cover_version` from the library API). Not
    /// used to pick the file; a versioned URL may be cached for good.
    pub v: Option<String>,
}

/// A missing cover stays missing for a while: cacheable 404, so grids do not
/// ask again on every render (a new cover comes with a new `?v=`).
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        )],
    )
        .into_response()
}

async fn album_cover(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<CoverQuery>,
    headers: HeaderMap,
) -> Response {
    match state.db.album_cover_path(id) {
        Ok(Some(path)) => serve_variant(&state, path, &q, &headers).await,
        Ok(None) => not_found(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn artist_cover(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<CoverQuery>,
    headers: HeaderMap,
) -> Response {
    match state.db.artist_cover_path(id) {
        Ok(Some(path)) => serve_variant(&state, path, &q, &headers).await,
        Ok(None) => not_found(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Serve a cached thumbnail when a size is requested, else the original file.
async fn serve_variant(
    state: &AppState,
    path: PathBuf,
    q: &CoverQuery,
    req: &HeaderMap,
) -> Response {
    let versioned = q.v.as_deref().is_some_and(|v| !v.trim().is_empty());
    let Some(size) = crate::thumbs::normalize_size(q.size) else {
        return serve_image(path, versioned, req).await;
    };
    let data_dir = state.config.lock_or_recover().data_dir.clone();
    let source = path.clone();
    let thumb =
        tokio::task::spawn_blocking(move || crate::thumbs::ensure_thumb(&data_dir, &source, size))
            .await;
    match thumb {
        Ok(Ok(thumb_path)) => serve_image(thumb_path, versioned, req).await,
        // Undecodable or unsupported source: fall back to the original bytes.
        _ => serve_image(path, versioned, req).await,
    }
}

/// Strong validator of an image file: size + mtime.
fn image_etag(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("\"c{:x}-{:x}\"", meta.len(), mtime)
}

async fn serve_image(path: PathBuf, versioned: bool, req: &HeaderMap) -> Response {
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return not_found();
    };
    if !meta.is_file() {
        return not_found();
    }
    let etag = image_etag(&meta);
    let mut headers = HeaderMap::new();
    // Versioned URLs change with the cover: cache for good. Plain URLs are
    // revalidated with the ETag after a short while.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if versioned {
            "public, max-age=31536000, immutable"
        } else {
            "public, max-age=300"
        }),
    );
    if let Ok(v) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, v);
    }
    let matches = req
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|list| {
            list.split(',')
                .any(|t| t.trim() == "*" || t.trim().trim_start_matches("W/") == etag)
        });
    if matches {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
            let body = Body::from_stream(ReaderStream::new(file));
            (StatusCode::OK, headers, body).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
