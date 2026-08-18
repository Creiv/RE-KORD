use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tokio_util::io::ReaderStream;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/media/{*path}", get(serve_media))
        .route("/api/v1/media/{*path}", get(serve_media))
}

async fn serve_media(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<String>,
    req: Request,
) -> Response {
    let rel = path.trim_start_matches('/');
    let file_path = match state.db.track_file_path_by_rel(rel) {
        Ok(Some(p)) => p,
        Ok(None) => {
            // allow direct relative path under music root as fallback
            let cfg = state.config.lock().unwrap();
            let Some(root) = cfg.music_root.clone() else {
                return (StatusCode::NOT_FOUND, "track not found").into_response();
            };
            let candidate = root.join(rel);
            if candidate.is_file() {
                candidate
            } else {
                return (StatusCode::NOT_FOUND, "track not found").into_response();
            }
        }
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response(),
    };

    if !file_path.is_file() {
        return (StatusCode::NOT_FOUND, "file missing").into_response();
    }

    let meta = match std::fs::metadata(&file_path) {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "file missing").into_response(),
    };
    let file_len = meta.len();
    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .to_string();

    let range_header = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(range_val) = range_header {
        match parse_single_range(&range_val, file_len) {
            Some((start, end)) => {
                let len = end - start + 1;
                match read_file_range(&file_path, start, len) {
                    Ok(bytes) => {
                        let mut headers = HeaderMap::new();
                        headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap());
                        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                        headers.insert(
                            header::CONTENT_LENGTH,
                            HeaderValue::from_str(&len.to_string()).unwrap(),
                        );
                        headers.insert(
                            header::CONTENT_RANGE,
                            HeaderValue::from_str(&format!("bytes {start}-{end}/{file_len}"))
                                .unwrap(),
                        );
                        (StatusCode::PARTIAL_CONTENT, headers, bytes).into_response()
                    }
                    Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response(),
                }
            }
            None => (StatusCode::RANGE_NOT_SATISFIABLE, "bad range").into_response(),
        }
    } else {
        match tokio::fs::File::open(&file_path).await {
            Ok(file) => {
                let stream = ReaderStream::new(file);
                let body = Body::from_stream(stream);
                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap());
                headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                headers.insert(
                    header::CONTENT_LENGTH,
                    HeaderValue::from_str(&file_len.to_string()).unwrap(),
                );
                (StatusCode::OK, headers, body).into_response()
            }
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "open error").into_response(),
        }
    }
}

fn parse_single_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let header = header.strip_prefix("bytes=")?;
    let (start_s, end_s) = header.split_once('-')?;
    if start_s.is_empty() {
        // suffix: bytes=-N
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 || file_len == 0 {
            return None;
        }
        let start = file_len.saturating_sub(suffix);
        return Some((start, file_len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= file_len {
        return None;
    }
    let end = if end_s.is_empty() {
        file_len - 1
    } else {
        end_s.parse::<u64>().ok()?.min(file_len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn read_file_range(path: &std::path::Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}
