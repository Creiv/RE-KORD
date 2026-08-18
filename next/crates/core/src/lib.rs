pub mod accounts;
pub mod api;
pub mod backup;
pub mod catalog_preview;
pub mod config;
pub mod cover;
pub mod db;
pub mod diagnostics;
pub mod disk_space;
pub mod entity_info;
pub mod errors;
pub mod jobs;
pub mod layout;
pub mod media;
pub mod metadata;
pub mod modules;
pub mod path_util;
pub mod perm;
pub mod remote_access;
pub mod scan;
pub mod selection;
pub mod state;
pub mod studio;
pub mod studio_fs;
pub mod thumbs;
pub mod user_state;
pub mod watcher;
pub mod youtube_music;
pub mod ytdlp;

pub use config::AppConfig;
pub use state::AppState;

use anyhow::Result;
use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::http::{Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum::Router;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;

/// Unmatched `/api/*` must return a JSON envelope (ServeDir otherwise yields empty 404).
async fn api_json_not_found(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "ok": false,
                "error": format!("not found: {path}"),
            })),
        )
            .into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

/// Attach `x-request-id` to every response (echoing the client value when present)
/// so hub logs and client reports can be correlated.
async fn request_id_layer(mut req: Request<Body>, next: axum::middleware::Next) -> Response {
    use axum::http::HeaderValue;
    let incoming = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= 64);
    let id = incoming.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Ok(value) = HeaderValue::from_str(&id) {
        req.headers_mut().insert("x-request-id", value.clone());
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", value);
        return res;
    }
    next.run(req).await
}

/// Static UI bundles the hub can serve: the client SPA on `/` and the admin
/// panel on `/admin`. They are independent, so the admin panel stays reachable
/// even when the client SPA is served for LAN / tunnel access.
#[derive(Debug, Clone, Default)]
pub struct UiDirs {
    pub client: Option<PathBuf>,
    pub admin: Option<PathBuf>,
}

impl UiDirs {
    pub fn client_only(dir: Option<PathBuf>) -> Self {
        Self {
            client: dir,
            admin: None,
        }
    }
}

/// Build the HTTP router: API + media + optional static UI (client SPA preferred).
pub fn build_router(state: AppState, ui: UiDirs) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    crate::diagnostics::mark_started();

    // Backup restore + artwork uploads can exceed axum's default 2 MiB body limit.
    let mut app = Router::new()
        .merge(api::routes())
        .merge(studio::routes())
        .merge(media::routes())
        .merge(cover::routes())
        .merge(user_state::routes())
        .merge(diagnostics::routes())
        .merge(jobs::routes())
        .merge(remote_access::routes())
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn(request_id_layer))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    if let Some(dir) = ui.admin.filter(|d| d.is_dir()) {
        info!(path = %dir.display(), "serving admin panel at /admin");
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(index));
        app = app.nest_service("/admin", serve);
    }

    if let Some(dir) = ui.client {
        if dir.is_dir() {
            info!(path = %dir.display(), "serving public UI");
            // Same-origin SPA for LAN / Cloudflare tunnel (API is relative when base URL empty).
            // API misses must not fall through to ServeDir (empty 404 → client `.json()` crash).
            let serve = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
            app = app.fallback(move |req: Request<Body>| {
                let serve = serve.clone();
                async move {
                    let path = req.uri().path();
                    if path.starts_with("/api/") || path == "/api" {
                        return (
                            StatusCode::NOT_FOUND,
                            Json(json!({
                                "ok": false,
                                "error": format!("not found: {path}"),
                            })),
                        )
                            .into_response();
                    }
                    match serve.oneshot(req).await {
                        Ok(res) => res.into_response(),
                        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                }
            });
        } else {
            app = app.fallback(api_json_not_found);
        }
    } else {
        app = app.fallback(api_json_not_found);
    }

    app
}

pub async fn serve(state: AppState, addr: SocketAddr, ui: UiDirs) -> Result<()> {
    // Index library in the background when music_root is set but never scanned,
    // so client/admin UIs don't open against an empty DB until a manual scan.
    state.spawn_initial_scan_if_needed();
    watcher::start(&state);
    thumbs::spawn_backfill(&state);

    let app = build_router(state, ui);
    info!(%addr, "RE-KORD server listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    // Connect info powers the loopback check for machine operations.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
