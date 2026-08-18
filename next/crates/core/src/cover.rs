use crate::state::AppState;
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
}

async fn album_cover(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<CoverQuery>,
) -> Response {
    match state.db.album_cover_path(id) {
        Ok(Some(path)) => serve_variant(&state, path, q.size).await,
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn artist_cover(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<CoverQuery>,
) -> Response {
    match state.db.artist_cover_path(id) {
        Ok(Some(path)) => serve_variant(&state, path, q.size).await,
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Serve a cached thumbnail when a size is requested, else the original file.
async fn serve_variant(state: &AppState, path: PathBuf, size: Option<u32>) -> Response {
    let Some(size) = crate::thumbs::normalize_size(size) else {
        return serve_image(path).await;
    };
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let source = path.clone();
    let thumb =
        tokio::task::spawn_blocking(move || crate::thumbs::ensure_thumb(&data_dir, &source, size))
            .await;
    match thumb {
        Ok(Ok(thumb_path)) => serve_image(thumb_path).await,
        // Undecodable or unsupported source: fall back to the original bytes.
        _ => serve_image(path).await,
    }
}

async fn serve_image(path: PathBuf) -> Response {
    if !path.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap());
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400"),
            );
            let body = Body::from_stream(ReaderStream::new(file));
            (StatusCode::OK, headers, body).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
