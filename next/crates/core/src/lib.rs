pub mod accounts;
pub mod api;
pub mod backup;
pub mod config;
pub mod cover;
pub mod db;
pub mod diagnostics;
pub mod disk_space;
pub mod remote_access;
pub mod entity_info;
pub mod media;
pub mod metadata;
pub mod modules;
pub mod path_util;
pub mod scan;
pub mod selection;
pub mod state;
pub mod studio;
pub mod studio_fs;
pub mod user_state;
pub mod youtube_music;
pub mod ytdlp;

pub use config::AppConfig;
pub use state::AppState;

use anyhow::Result;
use axum::extract::DefaultBodyLimit;
use axum::Router;
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::info;

/// Build the HTTP router: API + media + optional admin UI static files.
pub fn build_router(state: AppState, admin_ui_dir: Option<PathBuf>) -> Router {
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
        .merge(remote_access::routes())
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    if let Some(dir) = admin_ui_dir {
        if dir.is_dir() {
            info!(path = %dir.display(), "serving admin UI");
            app = app.fallback_service(ServeDir::new(dir));
        }
    }

    app
}

pub async fn serve(state: AppState, addr: SocketAddr, admin_ui_dir: Option<PathBuf>) -> Result<()> {
    // Index library in the background when music_root is set but never scanned,
    // so client/admin UIs don't open against an empty DB until a manual scan.
    state.spawn_initial_scan_if_needed();

    let app = build_router(state, admin_ui_dir);
    info!(%addr, "RE-KORD server listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
