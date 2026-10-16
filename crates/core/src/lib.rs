pub mod accounts;
pub mod api;
pub mod backup;
pub mod catalog_preview;
pub mod child_group;
pub mod config;
pub mod cover;
pub mod db;
pub mod diagnostics;
pub mod disk_space;
pub mod downloads;
pub mod embedded;
pub mod entity_info;
pub mod errors;
pub mod jobs;
pub mod js_runtime;
pub mod layout;
pub mod media;
pub mod metadata;
pub mod modules;
pub mod origin;
pub mod path_util;
pub mod perm;
pub mod podcasts;
pub mod power;
pub mod remote_access;
pub mod scan;
pub mod selection;
pub mod state;
pub mod studio;
pub mod studio_fs;
pub mod thumbs;
pub mod tools;
pub mod track_moods;
pub mod transcode;
pub mod user_state;
pub mod watcher;
pub mod youtube_music;
pub mod ytdlp;
pub mod ytdlp_cookies;
pub mod ytdlp_update;

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
use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

/// Default request body cap. Upload routes (restore, theme background,
/// artwork, cookies) raise it with their own `DefaultBodyLimit` layer.
pub const DEFAULT_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// How long in-flight responses (media streams) may run after shutdown is
/// requested before the server stops waiting for them.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

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
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
    let id = incoming.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Ok(value) = HeaderValue::from_str(&id) {
        req.headers_mut().insert("x-request-id", value.clone());
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", value);
        return res;
    }
    next.run(req).await
}

/// Request span carrying the id set by `request_id_layer` (which runs first).
fn request_span(req: &Request<Body>) -> tracing::Span {
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    tracing::info_span!(
        "request",
        method = %req.method(),
        uri = %req.uri().path(),
        request_id = %request_id,
    )
}

/// Response predicate of [`compression_layer`].
type CompressPredicate =
    fn(StatusCode, axum::http::Version, &axum::http::HeaderMap, &axum::http::Extensions) -> bool;

/// Compress text responses (JSON, JS, CSS, HTML, SVG) for clients that accept
/// gzip / br. Media, images and streamed NDJSON are left alone.
fn compression_layer() -> tower_http::compression::CompressionLayer<
    tower_http::compression::predicate::And<
        tower_http::compression::predicate::SizeAbove,
        CompressPredicate,
    >,
> {
    use tower_http::compression::predicate::{Predicate, SizeAbove};
    fn compressible(
        status: StatusCode,
        _: axum::http::Version,
        headers: &axum::http::HeaderMap,
        _: &axum::http::Extensions,
    ) -> bool {
        if status == StatusCode::PARTIAL_CONTENT
            || headers.contains_key(axum::http::header::CONTENT_RANGE)
        {
            return false;
        }
        let Some(ct) = headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        else {
            return false;
        };
        let ct = ct
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        matches!(
            ct.as_str(),
            "application/json"
                | "application/javascript"
                | "text/javascript"
                | "text/css"
                | "text/html"
                | "image/svg+xml"
                | "application/manifest+json"
                | "application/wasm"
        )
    }
    let pred: CompressPredicate = compressible;
    tower_http::compression::CompressionLayer::new().compress_when(SizeAbove::new(1024).and(pred))
}

/// Cache policy of the served UIs: Vite's hashed `/assets/*` never change
/// (cache for a year), `index.html` / `sw.js` (and SPA fallbacks) are always
/// revalidated so a new build is picked up at once.
async fn static_cache_headers(req: Request<Body>, next: axum::middleware::Next) -> Response {
    use axum::http::{header, HeaderValue};
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    if path.starts_with("/api/")
        || path.starts_with("/media/")
        || res.headers().contains_key(header::CACHE_CONTROL)
        || !(res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED)
    {
        return res;
    }
    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    let value = if path.contains("/assets/") && !is_html {
        "public, max-age=31536000, immutable"
    } else if is_html
        || path.ends_with("/sw.js")
        || path.ends_with(".webmanifest")
        || path.ends_with("/manifest.json")
    {
        "no-cache"
    } else {
        return res;
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
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
    crate::diagnostics::mark_started();

    let mut app: Router<AppState> = Router::new()
        .merge(api::routes())
        .merge(studio::routes())
        .merge(media::routes())
        .merge(transcode::routes())
        .merge(cover::routes())
        .merge(user_state::routes())
        .merge(diagnostics::routes())
        .merge(jobs::routes())
        .merge(remote_access::routes())
        .merge(podcasts::api::routes())
        .merge(power::api::routes());

    if let Some(dir) = ui.admin.filter(|d| d.is_dir()) {
        info!(path = %dir.display(), "serving admin panel at /admin");
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(index));
        app = app.nest_service("/admin", serve);
    }

    match ui.client.filter(|d| d.is_dir()) {
        Some(dir) => {
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
        }
        None => {
            app = app.fallback(api_json_not_found);
        }
    }

    // Layers wrap every route, nested service and fallback. Outermost last:
    // security headers → request id → trace span (reads the id) → origin
    // guard → CORS → compression → static cache headers → body limit.
    app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        power::api::activity_layer,
    ))
    .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
    .layer(axum::middleware::from_fn(static_cache_headers))
    .layer(compression_layer())
    .layer(origin::cors_layer())
    .layer(axum::middleware::from_fn(origin::origin_guard))
    .layer(TraceLayer::new_for_http().make_span_with(request_span))
    .layer(axum::middleware::from_fn(request_id_layer))
    .layer(axum::middleware::from_fn(origin::security_headers))
    .with_state(state)
}

/// Options for running a hub in-process (standalone server or desktop shell).
#[derive(Debug, Clone)]
pub struct HubOptions {
    pub bind: std::net::SocketAddr,
    pub data_dir: std::path::PathBuf,
    pub client_ui_dir: Option<std::path::PathBuf>,
    pub admin_ui_dir: Option<std::path::PathBuf>,
}

impl Default for HubOptions {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([0, 0, 0, 0], 7420)),
            data_dir: AppConfig::default_data_dir(),
            client_ui_dir: None,
            admin_ui_dir: None,
        }
    }
}

/// Load config + modules and open the DB for `opts.data_dir`.
///
/// `music_root` (when given) is persisted as the library path; the modules
/// manifest defaults to `REKORD_MODULES_MANIFEST` or `<data_dir>/modules.manifest.toml`.
pub fn prepare_hub_state(
    opts: &HubOptions,
    music_root: Option<&std::path::Path>,
    modules_manifest: Option<PathBuf>,
) -> Result<AppState> {
    let manifest = modules_manifest.or_else(|| {
        std::env::var_os("REKORD_MODULES_MANIFEST")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let mut config = AppConfig::resolve(Some(opts.data_dir.clone()), opts.bind, manifest);
    config.ensure_dirs()?;
    modules::write_default_manifest(&config.modules_manifest)?;
    config.set_music_root_if_present(music_root)?;
    let registry = modules::load_registry(&config.modules_manifest)?;
    info!(
        data_dir = %config.data_dir.display(),
        bind = %config.bind,
        enabled_modules = ?registry.enabled_ids(),
        "starting RE-KORD hub"
    );
    AppState::new(config, registry)
}

/// Run a hub until `shutdown` resolves, then stop background work (downloads,
/// tunnel, watcher) and return. Used by `rekord-server` and the desktop shell.
pub async fn run_hub(
    opts: HubOptions,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let state = prepare_hub_state(&opts, None, None)?;
    let ui = UiDirs {
        client: opts.client_ui_dir.clone(),
        admin: opts.admin_ui_dir.clone(),
    };
    serve_with_shutdown(state, opts.bind, ui, shutdown).await
}

/// Resolves on Ctrl-C, or SIGTERM on Unix.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            warn!(error = %e, "ctrl-c handler unavailable");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                warn!(error = %e, "SIGTERM handler unavailable");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// Stop everything that outlives a request: yt-dlp downloads, cancelable
/// jobs, the Cloudflare tunnel, the library watcher and the sleep lock.
pub async fn stop_background_work(state: &AppState) {
    state.power.shutdown();
    let downloads: Vec<_> = state
        .active_downloads
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    for flag in &downloads {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    state.jobs.cancel_all();
    remote_access::shutdown().await;
    watcher::stop(state);
    if !downloads.is_empty() {
        // The download tasks kill yt-dlp on their cancel flag; give them a moment.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline
            && !state.active_downloads.lock().unwrap().is_empty()
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    // Flush the SQLite WAL so the database file is complete on its own.
    let db = state.db.clone();
    match tokio::task::spawn_blocking(move || db.checkpoint()).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => tracing::warn!("database checkpoint incomplete (busy)"),
        Ok(Err(e)) => tracing::warn!(error = %e, "database checkpoint failed"),
        Err(e) => tracing::warn!(error = %e, "database checkpoint task failed"),
    }
}

pub async fn serve(state: AppState, addr: SocketAddr, ui: UiDirs) -> Result<()> {
    serve_with_shutdown(state, addr, ui, std::future::pending()).await
}

pub async fn serve_with_shutdown(
    state: AppState,
    addr: SocketAddr,
    ui: UiDirs,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    // Index library in the background when music_root is set but never scanned,
    // so client/admin UIs don't open against an empty DB until a manual scan.
    state.spawn_initial_scan_if_needed();
    // Probe yt-dlp / ffmpeg / cloudflared versions in the background.
    tools::spawn_warmup(&state.config.lock().unwrap().clone());
    watcher::start(&state);
    thumbs::spawn_backfill(&state);
    embedded::backfill::spawn_if_needed(&state);

    let app = build_router(state.clone(), ui);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "RE-KORD server listening");
    // Only a hub that actually serves may keep the computer awake.
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    state.power.start(Some(data_dir));

    let (signal_tx, signal_rx) = tokio::sync::oneshot::channel::<()>();
    // Connect info powers the loopback check for machine operations.
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown.await;
        let _ = signal_tx.send(());
    })
    .into_future();
    tokio::pin!(server);

    tokio::select! {
        res = &mut server => res?,
        Ok(()) = signal_rx => {
            info!("shutdown requested: stopping background work");
            // Ends yt-dlp NDJSON streams too, so graceful shutdown can finish.
            stop_background_work(&state).await;
            match tokio::time::timeout(SHUTDOWN_GRACE, &mut server).await {
                Ok(res) => res?,
                Err(_) => warn!("open connections did not close in time; stopping anyway"),
            }
        }
    }
    info!("RE-KORD server stopped");
    Ok(())
}
