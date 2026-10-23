//! Studio HTTP routes: download, fs, youtube, metadata, artwork, config.

use crate::accounts::{self, DEFAULT_ACCOUNT_ID};
use crate::catalog_preview;
use crate::entity_info::{self, EntityInfoSaveRequest};
use crate::metadata::entity_search::EntitySearchOptions;
use crate::metadata::{self, AlbumMetaPatch, TrackMetaPatch};
use crate::path_util::{has_reserved_segment, safe_rel_path};
use crate::perm::PeerAddr;
use crate::selection::{self, CatalogKeys, SelectionPatch};
use crate::state::AppState;
use crate::studio_fs;
use crate::sync::LockRecover;
use crate::youtube_music::{self, ReleaseEntry};
use crate::ytdlp::{self, is_allowed_ytdlp_url, is_uuid_download_id, normalize_http_url};
use crate::{downloads, tools, ytdlp_update};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use bytes::Bytes;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub fn routes() -> Router<AppState> {
    Router::new()
        // Config
        .route("/api/v1/config", get(get_config))
        .route("/api/config", get(get_config))
        .route(
            "/api/v1/config/youtube-cookies",
            post(upload_youtube_cookies)
                .delete(clear_youtube_cookies)
                .layer(DefaultBodyLimit::max(COOKIES_BODY_LIMIT)),
        )
        .route(
            "/api/config/youtube-cookies",
            post(upload_youtube_cookies)
                .delete(clear_youtube_cookies)
                .layer(DefaultBodyLimit::max(COOKIES_BODY_LIMIT)),
        )
        .route(
            "/api/v1/config/discogs-token",
            put(set_discogs_token).delete(clear_discogs_token),
        )
        .route(
            "/api/config/discogs-token",
            put(set_discogs_token).delete(clear_discogs_token),
        )
        // FS
        .route("/api/v1/fs/list", get(fs_list))
        .route("/api/fs/list", get(fs_list))
        .route("/api/v1/fs/search-dirs", get(fs_search))
        .route("/api/fs/search-dirs", get(fs_search))
        .route("/api/v1/fs/mkdir", post(fs_mkdir))
        .route("/api/fs/mkdir", post(fs_mkdir))
        .route(
            "/api/v1/fs/delete-audio-relpaths",
            post(fs_delete_audio_rel_paths),
        )
        .route(
            "/api/fs/delete-audio-relpaths",
            post(fs_delete_audio_rel_paths),
        )
        .route("/api/v1/fs/delete-album-folder", post(fs_delete_album))
        .route("/api/fs/delete-album-folder", post(fs_delete_album))
        // Download
        .route("/api/v1/download", post(start_download))
        .route("/api/download", post(start_download))
        .route("/api/v1/download-cancel", post(cancel_download))
        .route("/api/download-cancel", post(cancel_download))
        .route("/api/v1/download-flat-count", post(download_flat_count))
        .route("/api/download-flat-count", post(download_flat_count))
        .route("/api/v1/download/active", get(download_active))
        .route("/api/download/active", get(download_active))
        .route("/api/v1/download-preset", get(download_preset))
        .route("/api/download-preset", get(download_preset))
        // YouTube
        // Tools
        .route("/api/v1/tools/ytdlp/update", post(update_ytdlp))
        .route("/api/v1/youtube-explore-search", post(youtube_explore))
        .route("/api/youtube-explore-search", post(youtube_explore))
        .route("/api/v1/youtube-releases-list", post(youtube_releases))
        .route("/api/youtube-releases-list", post(youtube_releases))
        .route("/api/v1/catalog-web-discover", get(catalog_web_discover))
        .route("/api/catalog-web-discover", get(catalog_web_discover))
        .route("/api/v1/catalog-web-tracks", get(catalog_web_tracks))
        .route("/api/catalog-web-tracks", get(catalog_web_tracks))
        .route(
            "/api/v1/catalog-web-preview/stream",
            get(catalog_web_preview_stream),
        )
        .route(
            "/api/catalog-web-preview/stream",
            get(catalog_web_preview_stream),
        )
        .route("/api/v1/catalog-web-preview", get(catalog_web_preview))
        .route("/api/catalog-web-preview", get(catalog_web_preview))
        // Artwork
        .route("/api/v1/artwork/search", get(artwork_search))
        .route("/api/artwork/search", get(artwork_search))
        .route("/api/v1/artwork/apply", post(artwork_apply))
        .route("/api/artwork/apply", post(artwork_apply))
        .route(
            "/api/v1/artwork/upload",
            post(artwork_upload).layer(DefaultBodyLimit::max(ARTWORK_BODY_LIMIT)),
        )
        .route(
            "/api/artwork/upload",
            post(artwork_upload).layer(DefaultBodyLimit::max(ARTWORK_BODY_LIMIT)),
        )
        // Album / track info
        .route("/api/v1/album-info/fetch", post(album_info_fetch))
        .route("/api/album-info/fetch", post(album_info_fetch))
        .route("/api/v1/album-info/save", post(album_info_save))
        .route("/api/album-info/save", post(album_info_save))
        .route("/api/v1/track-info/fetch", post(track_info_fetch))
        .route("/api/track-info/fetch", post(track_info_fetch))
        .route(
            "/api/v1/track-info/fetch-album",
            post(track_info_fetch_album),
        )
        .route("/api/track-info/fetch-album", post(track_info_fetch_album))
        .route("/api/v1/track-info/save", post(track_info_save))
        .route("/api/track-info/save", post(track_info_save))
        .route(
            "/api/v1/track-info/prune-orphans",
            post(track_info_prune_orphans),
        )
        .route(
            "/api/track-info/prune-orphans",
            post(track_info_prune_orphans),
        )
        .route("/api/v1/track-lyrics/fetch", post(track_lyrics_fetch))
        .route("/api/track-lyrics/fetch", post(track_lyrics_fetch))
        .route(
            "/api/v1/studio/sanitize-track-titles",
            post(sanitize_track_titles),
        )
        .route(
            "/api/studio/sanitize-track-titles",
            post(sanitize_track_titles),
        )
        .route("/api/v1/discogs/search-releases", post(discogs_search))
        .route("/api/discogs/search-releases", post(discogs_search))
        .route("/api/v1/discogs/apply-release", post(discogs_apply))
        .route("/api/discogs/apply-release", post(discogs_apply))
        // Entity info mutate
        .route("/api/v1/entity-info/search", post(entity_info_search))
        .route("/api/entity-info/search", post(entity_info_search))
        .route("/api/v1/entity-info/save", post(entity_info_save))
        .route("/api/entity-info/save", post(entity_info_save))
        .route(
            "/api/v1/entity-info/batch-search",
            post(entity_info_batch_search),
        )
        .route(
            "/api/v1/entity-info/batch-save",
            post(entity_info_batch_save),
        )
        .route(
            "/api/v1/entity-info/batch-targets",
            post(entity_info_batch_targets),
        )
        .route("/api/v1/entity-info/batch-auto", post(entity_info_batch))
        .route("/api/v1/entity-info/batch", post(entity_info_batch))
}

/// Cookies file is capped at 2 MB; leave room for the multipart envelope.
const COOKIES_BODY_LIMIT: usize = 3 * 1024 * 1024;
/// Artwork upload: 15 MB image plus multipart overhead.
const ARTWORK_BODY_LIMIT: usize = crate::metadata::artwork::MAX_IMAGE_BYTES + 1024 * 1024;

fn ok<T: serde::Serialize>(data: T) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "data": data, "error": null }))
}

/// Error envelope: `error` is a stable snake_case code the client translates.
fn err(status: StatusCode, code: &'static str) -> Response {
    let body = json!({ "ok": false, "data": null, "error": code });
    (status, Json(body)).into_response()
}

/// Error envelope with an untranslated detail (`message`) for logs / tooltips.
fn err_detail(status: StatusCode, code: &'static str, detail: impl std::fmt::Display) -> Response {
    let body = json!({
        "ok": false,
        "data": null,
        "error": code,
        "message": detail.to_string(),
    });
    (status, Json(body)).into_response()
}

/// Map an upstream / provider failure to a code: rate limits, "nothing
/// found", timeouts, otherwise `fallback`.
fn upstream_code(e: &anyhow::Error, fallback: &'static str) -> (StatusCode, &'static str) {
    if let Some(p) = e.downcast_ref::<ytdlp::ProbeError>() {
        return (
            match p {
                ytdlp::ProbeError::NotFound => StatusCode::SERVICE_UNAVAILABLE,
                ytdlp::ProbeError::Timeout => StatusCode::GATEWAY_TIMEOUT,
                ytdlp::ProbeError::Failed(_) => StatusCode::BAD_GATEWAY,
            },
            p.code(),
        );
    }
    let m = e.to_string().to_ascii_lowercase();
    if m.contains("rate limit") || m.contains("429") {
        (StatusCode::TOO_MANY_REQUESTS, "upstream_rate_limited")
    } else if m.contains("timed out") || m.contains("timeout") {
        (StatusCode::GATEWAY_TIMEOUT, "upstream_timeout")
    } else if m.contains("not found") || m.contains("no metadata") || m.contains("no results") {
        (StatusCode::NOT_FOUND, "no_metadata_found")
    } else if m.contains("too short") {
        (StatusCode::BAD_REQUEST, "query_too_short")
    } else if m.contains("host not allowed") || m.contains("url not allowed") {
        (StatusCode::BAD_REQUEST, "url_not_allowed")
    } else {
        (StatusCode::BAD_GATEWAY, fallback)
    }
}

/// Metadata / artwork / entity-info failure: the metadata layer's own code
/// (`album_not_found`, `no_match`, `discogs_rate_limited`, …) when it has one,
/// else `fallback` (or a generic upstream code).
fn meta_err(e: anyhow::Error, fallback: &'static str, fallback_status: StatusCode) -> Response {
    let (status, code, message) = crate::metadata::error::classify(&e);
    if code != "internal_error" {
        return err_detail(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            code,
            message,
        );
    }
    let (st, c) = upstream_code(&e, fallback);
    let st = if c == fallback { fallback_status } else { st };
    err_detail(st, c, message)
}

fn upstream_err(e: anyhow::Error, fallback: &'static str) -> Response {
    let (status, mut code) = upstream_code(&e, fallback);
    if code == "upstream_rate_limited" && fallback.starts_with("discogs") {
        code = "discogs_rate_limited";
    }
    err_detail(status, code, e)
}

#[allow(clippy::result_large_err)]
fn music_root(state: &AppState) -> Result<std::path::PathBuf, Response> {
    state
        .config
        .lock_or_recover()
        .music_root
        .clone()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "music_root_not_set"))
}

#[derive(Debug, Deserialize, Default)]
struct AccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

/// Hub credentials (cookies, Discogs token) and tool updates are machine
/// operations: Default account and, unless remote admin is enabled, a local
/// client.
#[allow(clippy::result_large_err)]
fn require_machine_op(
    state: &AppState,
    headers: &HeaderMap,
    q: &AccountQuery,
    peer: Option<std::net::SocketAddr>,
) -> Result<(), Response> {
    crate::perm::require_machine_op(state, headers, q.account_id.as_deref(), peer).map(|_| ())
}

/// Studio writes to the library (legacy `ADMIN_MUTATION_PATHS`): any account
/// from the hub machine, remote clients only with remote admin enabled.
#[allow(clippy::result_large_err)]
fn require_library_op(
    state: &AppState,
    headers: &HeaderMap,
    _q: &AccountQuery,
    peer: Option<std::net::SocketAddr>,
) -> Result<(), Response> {
    crate::perm::require_library_op(state, headers, peer).map(|_| ())
}

/// Early-return the 403 when the caller may not write to the library.
macro_rules! library_op_or_return {
    ($state:expr, $headers:expr, $q:expr, $peer:expr) => {
        if let Err(response) = require_library_op($state, $headers, $q, $peer) {
            return response;
        }
    };
}

/// Run blocking filesystem work off the async workers.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!(e.to_string())))
}

/// Drive an async metadata routine (sidecar + DB writes, mostly blocking IO)
/// on the blocking pool.
async fn blocking_async<T, F>(make: impl FnOnce() -> F + Send + 'static) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: std::future::Future<Output = anyhow::Result<T>>,
{
    let handle = tokio::runtime::Handle::current();
    blocking(move || handle.block_on(make())).await
}

fn config_snapshot_for_account(
    state: &AppState,
    headers: &HeaderMap,
    q: &AccountQuery,
    peer: Option<std::net::SocketAddr>,
) -> serde_json::Value {
    let mut snap = state.config.lock_or_recover().config_snapshot();
    let access = crate::perm::machine_op_status(state, headers, q.account_id.as_deref(), peer);
    let can_manage = access
        .get("canManageMachine")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(obj) = snap.as_object_mut() {
        if !can_manage {
            obj.insert("youtubeCookiesWritable".into(), json!(false));
            obj.insert("discogsWritable".into(), json!(false));
        }
        obj.insert("machineAccess".into(), access);
    }
    snap
}

async fn get_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
) -> impl IntoResponse {
    ok(config_snapshot_for_account(&state, &headers, &q, peer))
}

async fn upload_youtube_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    mut multipart: Multipart,
) -> Response {
    if let Err(e) = require_machine_op(&state, &headers, &q, peer) {
        return e;
    }
    let mut bytes: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            match field.bytes().await {
                Ok(b) => bytes = Some(b.to_vec()),
                Err(e) => return err_detail(StatusCode::BAD_REQUEST, "upload_failed", e),
            }
        }
    }
    let Some(bytes) = bytes else {
        return err(StatusCode::BAD_REQUEST, "file_required");
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return err(StatusCode::BAD_REQUEST, "file_too_large");
    }
    // Snapshot under the same guard: a `match` on `lock().method()` keeps the
    // MutexGuard alive for the whole match (incl. arms) → re-lock would deadlock.
    let snap = {
        let mut cfg = state.config.lock_or_recover();
        if let Err(e) = cfg.set_youtube_cookies_bytes(&bytes) {
            return err_detail(StatusCode::BAD_REQUEST, credential_code(&e, "cookies"), e);
        }
        cfg.config_snapshot()
    };
    ok(snap).into_response()
}

async fn clear_youtube_cookies(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
) -> Response {
    if let Err(e) = require_machine_op(&state, &headers, &q, peer) {
        return e;
    }
    let snap = {
        let mut cfg = state.config.lock_or_recover();
        if let Err(e) = cfg.clear_youtube_cookies() {
            return err_detail(StatusCode::BAD_REQUEST, credential_code(&e, "cookies"), e);
        }
        cfg.config_snapshot()
    };
    ok(snap).into_response()
}

/// `cookies_locked_by_env` / `cookies_invalid` (and the Discogs equivalents).
fn credential_code(e: &anyhow::Error, kind: &str) -> &'static str {
    use crate::ytdlp_cookies::CookieFormatError;
    let msg = e.to_string();
    let locked = msg.contains("environment");
    match (kind, locked) {
        ("cookies", true) => "cookies_locked_by_env",
        ("cookies", false) if msg == CookieFormatError::Json.message() => "cookies_json",
        ("cookies", false)
            if msg == CookieFormatError::Empty.message()
                || msg == CookieFormatError::NoCookies.message() =>
        {
            "cookies_empty"
        }
        ("cookies", false) => "cookies_invalid",
        (_, true) => "discogs_token_locked_by_env",
        (_, false) => "discogs_token_invalid",
    }
}

#[derive(Deserialize)]
struct DiscogsTokenBody {
    token: String,
}

async fn set_discogs_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<DiscogsTokenBody>,
) -> Response {
    if let Err(e) = require_machine_op(&state, &headers, &q, peer) {
        return e;
    }
    let snap = {
        let mut cfg = state.config.lock_or_recover();
        if let Err(e) = cfg.set_discogs_token(&body.token) {
            return err_detail(StatusCode::BAD_REQUEST, credential_code(&e, "discogs"), e);
        }
        cfg.config_snapshot()
    };
    ok(snap).into_response()
}

async fn clear_discogs_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
) -> Response {
    if let Err(e) = require_machine_op(&state, &headers, &q, peer) {
        return e;
    }
    let snap = {
        let mut cfg = state.config.lock_or_recover();
        if let Err(e) = cfg.clear_discogs_token() {
            return err_detail(StatusCode::BAD_REQUEST, credential_code(&e, "discogs"), e);
        }
        cfg.config_snapshot()
    };
    ok(snap).into_response()
}

#[derive(Deserialize)]
struct FsListQuery {
    path: Option<String>,
}

async fn fs_list(State(state): State<AppState>, Query(q): Query<FsListQuery>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = q.path.unwrap_or_default();
    if has_reserved_segment(&rel) {
        return err(StatusCode::BAD_REQUEST, "invalid_path");
    }
    match blocking(move || studio_fs::list_dirs(&root, &rel)).await {
        Ok(data) => {
            // Legacy raw shape + envelope
            ok(data).into_response()
        }
        Err(e) => err_detail(StatusCode::BAD_REQUEST, "fs_list_failed", e),
    }
}

#[derive(Deserialize)]
struct FsSearchQuery {
    q: Option<String>,
}

async fn fs_search(State(state): State<AppState>, Query(q): Query<FsSearchQuery>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let query = q.q.unwrap_or_default();
    match blocking(move || studio_fs::search_dirs(&root, &query, 40)).await {
        Ok((results, truncated)) => {
            ok(json!({ "results": results, "truncated": truncated })).into_response()
        }
        Err(e) => err_detail(StatusCode::BAD_REQUEST, "fs_search_failed", e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MkdirBody {
    parent: Option<String>,
    name: String,
}

async fn fs_mkdir(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<MkdirBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let parent = body.parent.unwrap_or_default();
    if has_reserved_segment(&parent) || has_reserved_segment(&body.name) {
        return err(StatusCode::BAD_REQUEST, "invalid_path");
    }
    let name = body.name;
    match blocking(move || studio_fs::mkdir(&root, &parent, &name)).await {
        Ok(rel) => ok(json!({ "ok": true, "relPath": rel })).into_response(),
        Err(e) => err_detail(StatusCode::BAD_REQUEST, "mkdir_failed", e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAudioBody {
    rel_paths: Vec<String>,
}

/// Album folders touched by a set of track paths, for the client to refresh.
fn album_folders_of(rel_paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for rel in rel_paths {
        let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 2 {
            continue;
        }
        let folder = parts[..parts.len() - 1].join("/");
        if !out.contains(&folder) {
            out.push(folder);
        }
    }
    out
}

/// Rows of tracks that no longer exist, plus albums and artists left empty.
/// The `tracks` delete trigger writes the tombstones the delta sync reads, so
/// other clients drop the same tracks without a rescan.
fn forget_deleted_tracks(state: &AppState, deleted: &[String]) {
    for rel in deleted {
        let _ = state.db.delete_track_by_rel(rel);
    }
    let _ = state.db.prune_empty_albums();
    let _ = state.db.prune_empty_artists();
}

async fn fs_delete_audio_rel_paths(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<DeleteAudioBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    if body.rel_paths.is_empty() {
        return err(StatusCode::BAD_REQUEST, "rel_paths_required");
    }
    let rels = body.rel_paths;
    let report = match blocking(move || Ok(studio_fs::delete_audio_files(&root, &rels))).await {
        Ok(r) => r,
        Err(e) => return err_detail(StatusCode::INTERNAL_SERVER_ERROR, "delete_failed", e),
    };
    forget_deleted_tracks(&state, &report.deleted);
    ok(json!({
        "deleted": report.deleted,
        "skipped": report.skipped,
        "affectedAlbums": album_folders_of(&report.deleted),
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAlbumBody {
    album_path: String,
}

async fn fs_delete_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<DeleteAlbumBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let album_path = body.album_path;
    let removed = match blocking(move || studio_fs::delete_album_folder(&root, &album_path)).await {
        Ok(r) => r,
        Err(e) => return err_detail(StatusCode::BAD_REQUEST, "delete_album_failed", e),
    };
    // Per rel path first: nested discs live in their own album rows, which the
    // folder key of the parent would leave behind.
    for rel in &removed.deleted {
        let _ = state.db.delete_track_by_rel(rel);
    }
    let _ = state.db.delete_album_by_folder(&removed.folder);
    let _ = state.db.prune_empty_albums();
    let _ = state.db.prune_empty_artists();
    ok(json!({
        "deleted": removed.deleted,
        "deletedFolder": removed.folder,
        "affectedAlbums": [removed.folder.clone()],
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBody {
    url: String,
    download_id: String,
    download_kind: Option<String>,
    output_dir: Option<String>,
    /// Keep running when the client disconnects (default: stop yt-dlp).
    background: Option<bool>,
}

fn ndjson_response(stream: downloads::NdjsonStream) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
}

async fn start_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<DownloadBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &aq, peer);
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "ytdlp_disabled");
    }
    let url = normalize_http_url(&body.url);
    if !is_allowed_ytdlp_url(&url) {
        return err(StatusCode::BAD_REQUEST, "url_not_allowed");
    }
    if !is_uuid_download_id(&body.download_id) {
        return err(StatusCode::BAD_REQUEST, "invalid_download_id");
    }
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let kind = body
        .download_kind
        .unwrap_or_else(|| "download_unknown".into());
    let output_dir = match safe_rel_path(body.output_dir.as_deref().unwrap_or("")) {
        Ok(s) if !has_reserved_segment(&s) => s,
        Ok(_) => return err(StatusCode::BAD_REQUEST, "invalid_output_dir"),
        Err(e) => return err_detail(StatusCode::BAD_REQUEST, "invalid_output_dir", e),
    };
    // The destination must stay inside the library even through symlinks.
    if !output_dir.is_empty() && !crate::path_util::under_root(&root.join(&output_dir), &root) {
        return err(StatusCode::BAD_REQUEST, "invalid_output_dir");
    }

    let data_dir = state.config.lock_or_recover().data_dir.clone();
    let account_id =
        match accounts::account_from_request(&data_dir, &headers, aq.account_id.as_deref()) {
            Ok(id) => id,
            Err(e) => return err(e.status(), e.code()),
        };

    let folder = if output_dir.is_empty() {
        ".".to_string()
    } else {
        output_dir.clone()
    };
    let started = downloads::start(
        &state,
        downloads::StartRequest {
            download_id: body.download_id.trim().to_string(),
            url,
            kind: kind.clone(),
            output_dir,
            account_id: account_id.clone(),
            background: body.background.unwrap_or(false),
            music_root: root,
        },
    );
    match started {
        Ok(stream) => {
            crate::diagnostics::log_activity(
                &data_dir,
                crate::diagnostics::ActivityEvent::new(
                    "download",
                    "started",
                    format!("download started ({kind}): {folder}"),
                )
                .params(json!({ "kind": kind, "folder": folder }))
                .account(Some(&account_id)),
            );
            ndjson_response(stream)
        }
        Err(code) => err(StatusCode::CONFLICT, code),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveDownloadQuery {
    download_id: Option<String>,
    /// `1` / `true`: re-attach an NDJSON stream to `downloadId`.
    stream: Option<String>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

/// Running and recently finished downloads (progress, log tail, can-cancel),
/// or an NDJSON re-attach to one of them.
async fn download_active(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ActiveDownloadQuery>,
) -> Response {
    let aq = AccountQuery {
        account_id: q.account_id.clone(),
    };
    library_op_or_return!(&state, &headers, &aq, peer);
    let want_stream = matches!(q.stream.as_deref(), Some("1") | Some("true"));
    if let Some(id) = q
        .download_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let Some(job) = downloads::find(&state, id) else {
            return err(StatusCode::NOT_FOUND, "download_not_found");
        };
        if want_stream {
            return ndjson_response(downloads::attach(job, true));
        }
        return ok(json!({ "downloads": [job.status_json()] })).into_response();
    }
    if want_stream {
        return err(StatusCode::BAD_REQUEST, "download_id_required");
    }
    let list: Vec<serde_json::Value> = downloads::list(&state)
        .iter()
        .map(|j| j.status_json())
        .collect();
    ok(json!({ "downloads": list })).into_response()
}

pub(crate) fn attach_download_to_selection(state: &AppState, account_id: &str, output_dir: &str) {
    let data_dir = state.config.lock_or_recover().data_dir.clone();
    let acc = if account_id.trim().is_empty() {
        DEFAULT_ACCOUNT_ID
    } else {
        account_id
    };
    let Ok(sel) = selection::read_library_selection(&data_dir, acc) else {
        return;
    };
    if sel.include_all {
        return;
    }
    let Ok(keys_set) = state.db.all_album_folder_keys() else {
        return;
    };
    let prefix = output_dir.trim_end_matches('/');
    // Only attach matching album folders — do not add the artist (that would pull
    // every album by that artist into the personal library).
    let mut add_albums = Vec::new();
    for key in &keys_set {
        if key == prefix || key.starts_with(&format!("{prefix}/")) {
            add_albums.push(key.clone());
        }
    }
    if add_albums.is_empty() {
        return;
    }
    let artists = state.db.list_artists().unwrap_or_default();
    let albums = state.db.list_albums().unwrap_or_default();
    let catalog = CatalogKeys::from_albums_and_artists(&artists, &albums);
    let patch = SelectionPatch {
        include_all: None,
        add_artists: None,
        remove_artists: None,
        add_albums: Some(add_albums),
        remove_albums: None,
        add_tracks: None,
        remove_tracks: None,
    };
    let next = selection::merge_selection_patch(&sel, &patch, &catalog);
    let _ = selection::write_library_selection(&data_dir, acc, &next);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelBody {
    download_id: String,
}

async fn cancel_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<CancelBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    if let Some(job) = downloads::find(&state, &body.download_id) {
        job.request_cancel("user");
        return ok(json!({ "ok": true, "found": true, "status": job.status().as_str() }))
            .into_response();
    }
    if let Some(flag) = state
        .active_downloads
        .lock_or_recover()
        .get(&body.download_id)
    {
        flag.store(true, Ordering::SeqCst);
        return ok(json!({ "ok": true, "found": true })).into_response();
    }
    ok(json!({ "ok": true, "found": false })).into_response()
}

#[derive(Deserialize)]
struct UrlBody {
    url: String,
}

/// Track count of a playlist / release. A count yt-dlp cannot establish is
/// reported as unknown (`count: null, known: false`), never as 0.
async fn download_flat_count(State(state): State<AppState>, Json(body): Json<UrlBody>) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "ytdlp_disabled");
    }
    let url = normalize_http_url(&body.url);
    if !is_allowed_ytdlp_url(&url) {
        return err(StatusCode::BAD_REQUEST, "url_not_allowed");
    }
    let cfg = state.config.lock_or_recover().clone();
    match youtube_music::flat_playlist_count(&cfg, &url).await {
        Ok(Some(count)) => ok(json!({ "count": count, "known": true })).into_response(),
        Ok(None) => ok(json!({ "count": null, "known": false })).into_response(),
        Err(e) => {
            let (_, code) = upstream_code(&e, "flat_count_failed");
            ok(json!({
                "count": null,
                "known": false,
                "error": code,
                "message": e.to_string(),
            }))
            .into_response()
        }
    }
}

async fn download_preset(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.config.lock_or_recover().clone();
    let ctx = tools::ToolContext::from_config(&cfg);
    let (ytdlp, js_runtime) = tokio::join!(
        tools::resolve(tools::Tool::Ytdlp, &ctx),
        crate::js_runtime::resolve()
    );
    let cookies = cfg.youtube_cookies_for_ytdlp().is_some();
    let program = ytdlp
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "yt-dlp".into());
    // Like yt-dlp's (`program`), the runtime's path stays on the hub: any
    // Studio user reads this, and it may name a home folder.
    let mut js = crate::js_runtime::status_json(&js_runtime);
    if let Some(o) = js.as_object_mut() {
        o.remove("path");
    }
    ok(json!({
        "found": ytdlp.available,
        "file": null,
        "text": "RE-KORD Studio yt-dlp preset",
        "program": program,
        "version": ytdlp.version,
        "source": ytdlp.source,
        "cookiesConfigured": cookies,
        "jsRuntime": js,
        "args": ["-f", ytdlp::AUDIO_FORMAT],
        "exampleUrl": null,
    }))
}

#[derive(Deserialize, Default)]
struct UpdateToolBody {
    force: Option<bool>,
}

/// `POST /api/v1/tools/ytdlp/update`: install the latest official yt-dlp into
/// `<data_dir>/tools` (machine operation).
async fn update_ytdlp(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    body: Option<Json<UpdateToolBody>>,
) -> Response {
    if let Err(e) = require_machine_op(&state, &headers, &q, peer) {
        return e;
    }
    let force = body.and_then(|Json(b)| b.force).unwrap_or(false);
    let cfg = state.config.lock_or_recover().clone();
    let ctx = tools::ToolContext::from_config(&cfg);
    match ytdlp_update::update_ytdlp(&ctx, force).await {
        Ok(report) => {
            if report.updated {
                let from = report.previous_version.as_deref().unwrap_or("?");
                crate::diagnostics::log_activity(
                    &cfg.data_dir,
                    crate::diagnostics::ActivityEvent::new(
                        "system",
                        "ytdlpUpdated",
                        format!("yt-dlp updated: {from} → {}", report.latest_version),
                    )
                    .params(json!({ "from": from, "to": report.latest_version })),
                );
            }
            ok(report).into_response()
        }
        Err(e) => err_detail(e.status(), e.code(), e),
    }
}

#[derive(Deserialize)]
struct ExploreBody {
    query: String,
    hl: Option<String>,
    gl: Option<String>,
}

fn accept_language(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
}

async fn youtube_explore(headers: HeaderMap, Json(body): Json<ExploreBody>) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "ytdlp_disabled");
    }
    if body.query.trim().chars().count() < 2 {
        return err(StatusCode::BAD_REQUEST, "query_too_short");
    }
    let locale = youtube_music::YtmLocale::from_request(
        body.hl.as_deref(),
        body.gl.as_deref(),
        accept_language(&headers),
    );
    match youtube_music::explore_search_with(&body.query, &locale).await {
        Ok(results) => ok(json!({ "results": results })).into_response(),
        Err(e) => upstream_err(e, "youtube_search_failed"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleasesBody {
    url: String,
    stream: Option<bool>,
    enrich_counts: Option<bool>,
}

async fn youtube_releases(
    State(state): State<AppState>,
    Json(body): Json<ReleasesBody>,
) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "ytdlp_disabled");
    }
    let url = normalize_http_url(&body.url);
    if !youtube_music::is_youtube_releases_tab_url(&url)
        && !youtube_music::is_youtube_music_browse_url(&url)
    {
        return err(StatusCode::BAD_REQUEST, "invalid_releases_url");
    }
    let cfg = state.config.lock_or_recover().clone();
    let enrich = body.enrich_counts.unwrap_or(false);
    let stream = body.stream.unwrap_or(false);

    if stream {
        let (tx, rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            match youtube_music::releases_list_for_url(&cfg, &url).await {
                Ok(list) => {
                    let _ = tx
                        .send(
                            json!({
                                "type": "meta",
                                "listTitle": list.list_title,
                                "uploader": list.uploader,
                                "channelUrl": list.channel_url,
                                "total": list.entries.len(),
                            })
                            .to_string(),
                        )
                        .await;
                    for e in &list.entries {
                        let _ = tx
                            .send(json!({ "type": "entry", "entry": e }).to_string())
                            .await;
                    }
                    let _ = tx.send(r#"{"type":"list_ready"}"#.into()).await;
                    if enrich {
                        for e in list.entries {
                            let count = youtube_music::enrich_track_count(&cfg, &e.url).await;
                            let patched = ReleaseEntry {
                                track_count: count,
                                ..e
                            };
                            let _ = tx
                                .send(
                                    json!({ "type": "entry_patch", "entry": patched }).to_string(),
                                )
                                .await;
                        }
                    }
                    let _ = tx.send(r#"{"type":"done"}"#.into()).await;
                }
                Err(e) => {
                    let (_, code) = upstream_code(&e, "youtube_releases_failed");
                    let _ = tx
                        .send(
                            json!({ "type": "error", "error": code, "message": e.to_string() })
                                .to_string(),
                        )
                        .await;
                }
            }
        });
        let stream = ReceiverStream::new(rx).map(|line| {
            let payload = if line.ends_with('\n') {
                line
            } else {
                format!("{line}\n")
            };
            Ok::<_, Infallible>(Bytes::from(payload))
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-ndjson"),
        );
        return (StatusCode::OK, headers, Body::from_stream(stream)).into_response();
    }

    match youtube_music::releases_list_for_url(&cfg, &url).await {
        Ok(mut list) => {
            if enrich {
                for e in &mut list.entries {
                    e.track_count = youtube_music::enrich_track_count(&cfg, &e.url).await;
                }
            }
            ok(list).into_response()
        }
        Err(e) => upstream_err(e, "youtube_releases_failed"),
    }
}

#[derive(Deserialize)]
struct DiscoverQuery {
    hl: Option<String>,
    gl: Option<String>,
    locale: Option<String>,
}

/// New releases not in the library. Feed failures come back structured in
/// `errors` (the response stays 200 with whatever could be loaded).
async fn catalog_web_discover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DiscoverQuery>,
) -> Response {
    let locale = youtube_music::YtmLocale::from_request(
        q.hl.as_deref().or(q.locale.as_deref()),
        q.gl.as_deref(),
        accept_language(&headers),
    );
    let db = state.db.clone();
    let library = tokio::task::spawn_blocking(move || {
        let albums = db.list_albums().unwrap_or_default();
        youtube_music::library_album_keys(
            albums
                .iter()
                .map(|a| (a.artist_name.as_str(), a.name.as_str())),
        )
    })
    .await
    .unwrap_or_default();
    let data = youtube_music::catalog_web_discover(&library, &locale).await;
    ok(data).into_response()
}

#[derive(Deserialize)]
struct CatalogWebUrlQuery {
    url: Option<String>,
}

async fn catalog_web_tracks(
    State(state): State<AppState>,
    Query(q): Query<CatalogWebUrlQuery>,
) -> Response {
    let raw = q.url.unwrap_or_default();
    if catalog_preview::normalize_catalog_web_url(&raw).is_none() {
        return err(StatusCode::BAD_REQUEST, "invalid_catalog_url");
    }
    let cfg = state.config.lock_or_recover().clone();
    ok(catalog_preview::release_tracks(&cfg, &raw).await).into_response()
}

async fn catalog_web_preview(
    State(state): State<AppState>,
    Query(q): Query<CatalogWebUrlQuery>,
) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "ytdlp_disabled");
    }
    let raw = q.url.unwrap_or_default();
    if catalog_preview::normalize_catalog_web_url(&raw).is_none() {
        return err(StatusCode::BAD_REQUEST, "invalid_catalog_url");
    }
    let cfg = state.config.lock_or_recover().clone();
    match catalog_preview::create_preview_token(&cfg, &raw).await {
        Ok(token) => ok(json!({
            "playUrl": format!("/api/v1/catalog-web-preview/stream?t={token}"),
            "expiresInSecs": catalog_preview::TOKEN_TTL.as_secs(),
        }))
        .into_response(),
        Err(e) => {
            let code = e.code();
            let status = match code {
                "ytdlp_not_found" => StatusCode::SERVICE_UNAVAILABLE,
                "preview_timeout" => StatusCode::GATEWAY_TIMEOUT,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            err_detail(status, code, e)
        }
    }
}

#[derive(Deserialize)]
struct PreviewStreamQuery {
    t: Option<String>,
}

/// Proxies the resolved audio so the signed upstream URL never leaves the hub.
async fn catalog_web_preview_stream(
    headers: HeaderMap,
    Query(q): Query<PreviewStreamQuery>,
) -> Response {
    let token = q.t.unwrap_or_default();
    let Some(stream_url) = catalog_preview::preview_stream_url(&token) else {
        return err(StatusCode::GONE, "preview_expired");
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("bytes=0-{}", catalog_preview::initial_range_bytes() - 1));
    let client = crate::net::client(
        "studio preview",
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(30),
    );
    let upstream = match client
        .get(&stream_url)
        .header(reqwest::header::RANGE, range)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err_detail(StatusCode::BAD_GATEWAY, "preview_upstream_unreachable", e),
    };
    // Never relay an upstream error as-is (an empty-body 403 reads as a broken
    // <audio> source in the browser): answer with a JSON code instead.
    if !upstream.status().is_success() {
        let up = upstream.status().as_u16();
        let (status, code) = match up {
            403 => (StatusCode::BAD_GATEWAY, "preview_upstream_forbidden"),
            404 | 410 => (StatusCode::GONE, "preview_expired"),
            416 => (StatusCode::RANGE_NOT_SATISFIABLE, "preview_range_invalid"),
            429 => (StatusCode::TOO_MANY_REQUESTS, "upstream_rate_limited"),
            _ => (StatusCode::BAD_GATEWAY, "preview_upstream_error"),
        };
        if up == 403 || up == 404 || up == 410 {
            // The signed URL is dead: make the token fail fast from now on.
            catalog_preview::forget_token(&token);
        }
        return err_detail(status, code, format!("upstream HTTP {up}"));
    }
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
    ] {
        if let Some(v) = upstream.headers().get(&name) {
            out.insert(name, v.clone());
        }
    }
    if !out.contains_key(header::CONTENT_TYPE) {
        out.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mp4"));
    }
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    let body = Body::from_stream(upstream.bytes_stream());
    (status, out, body).into_response()
}

#[derive(Deserialize)]
struct ArtworkSearchQuery {
    q: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    term: Option<String>,
}

async fn artwork_search(
    State(state): State<AppState>,
    Query(q): Query<ArtworkSearchQuery>,
) -> Response {
    let cfg = state.config.lock_or_recover().clone();
    let query = q.q.or(q.term);
    match metadata::search_artwork_detailed(
        &cfg,
        query.as_deref(),
        q.artist.as_deref(),
        q.album.as_deref(),
    )
    .await
    {
        // `errors`: sources that failed (results are partial when not empty).
        Ok(res) => ok(json!({ "results": res.results, "errors": res.errors })).into_response(),
        Err(e) => meta_err(e, "artwork_search_failed", StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtworkApplyBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    image_url: String,
}

#[allow(clippy::result_large_err)]
fn resolve_album_path(
    state: &AppState,
    album_path: Option<&str>,
    album_id: Option<i64>,
) -> Result<String, Response> {
    if let Some(p) = album_path.map(str::trim).filter(|s| !s.is_empty()) {
        let rel = safe_rel_path(p)
            .map_err(|e| err_detail(StatusCode::BAD_REQUEST, "invalid_album_path", e))?;
        if has_reserved_segment(&rel) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_album_path"));
        }
        return Ok(rel);
    }
    if let Some(id) = album_id {
        return state
            .db
            .get_album(id)
            .map_err(|e| err_detail(StatusCode::INTERNAL_SERVER_ERROR, "db_error", e))?
            .map(|a| a.folder_key)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "album_not_found"));
    }
    Err(err(StatusCode::BAD_REQUEST, "album_ref_required"))
}

/// Track rel path from `relPath` or `trackId`.
#[allow(clippy::result_large_err)]
fn resolve_track_rel(
    state: &AppState,
    rel_path: Option<String>,
    track_id: Option<i64>,
) -> Result<String, Response> {
    if let Some(p) = rel_path.filter(|p| !p.trim().is_empty()) {
        return Ok(p);
    }
    match track_id {
        Some(id) => match state.db.get_track(id) {
            Ok(Some(t)) => Ok(t.rel_path),
            _ => Err(err(StatusCode::NOT_FOUND, "track_not_found")),
        },
        None => Err(err(StatusCode::BAD_REQUEST, "track_ref_required")),
    }
}

async fn artwork_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<ArtworkApplyBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    match metadata::apply_artwork_url(&root, &state.db, &path, &body.image_url).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "artwork_apply_failed", StatusCode::BAD_GATEWAY),
    }
}

async fn artwork_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    mut multipart: Multipart,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let mut album_path: Option<String> = None;
    let mut album_id: Option<i64> = None;
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut content_type = String::from("image/jpeg");
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "albumPath" | "album_path" => {
                album_path = field.text().await.ok();
            }
            "albumId" | "album_id" => {
                album_id = field.text().await.ok().and_then(|s| s.parse().ok());
            }
            "file" => {
                content_type = field.content_type().unwrap_or("image/jpeg").to_string();
                file_bytes = field.bytes().await.ok().map(|b| b.to_vec());
            }
            _ => {}
        }
    }
    let Some(bytes) = file_bytes else {
        return err(StatusCode::BAD_REQUEST, "file_required");
    };
    let path = match resolve_album_path(&state, album_path.as_deref(), album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let db = state.db.clone();
    let res = blocking_async(move || async move {
        metadata::upload_artwork(&root, &db, &path, &bytes, &content_type).await
    })
    .await;
    match res {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "artwork_upload_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumFetchBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    artist: Option<String>,
    album: Option<String>,
    /// Replace the album name with the fetched title (never over a name a
    /// person typed).
    overwrite_title: Option<bool>,
}

async fn album_info_fetch(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<AlbumFetchBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let cfg = state.config.lock_or_recover().clone();
    let opts = metadata::AlbumFetchOptions {
        overwrite_title: body.overwrite_title.unwrap_or(false),
    };
    match metadata::album_info_fetch_with(
        &cfg,
        &root,
        &state.db,
        &path,
        body.artist.as_deref(),
        body.album.as_deref(),
        &opts,
    )
    .await
    {
        Ok(v) => Json(v).into_response(), // flat ok like legacy
        Err(e) => meta_err(e, "album_info_fetch_failed", StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumSaveBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    patch: AlbumMetaPatch,
}

async fn album_info_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<AlbumSaveBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let db = state.db.clone();
    let patch = body.patch;
    let res = blocking(move || metadata::album_info_save(&root, &db, &path, patch)).await;
    match res {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "album_info_save_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackFetchBody {
    rel_path: Option<String>,
    track_id: Option<i64>,
}

async fn track_info_fetch(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<TrackFetchBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = match resolve_track_rel(&state, body.rel_path, body.track_id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let cfg = state.config.lock_or_recover().clone();
    match metadata::track_info_fetch(&cfg, &root, &state.db, &rel).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => meta_err(e, "track_info_fetch_failed", StatusCode::BAD_GATEWAY),
    }
}

async fn track_info_fetch_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<AlbumFetchBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let cfg = state.config.lock_or_recover().clone();
    match metadata::track_info_fetch_album(&cfg, &root, &state.db, &path).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "track_info_fetch_failed", StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackSaveBody {
    rel_path: Option<String>,
    track_id: Option<i64>,
    patch: serde_json::Value,
}

/// Legacy carve-out: a patch touching only `mood`/`moods` is personal state,
/// so it never needed host rights (moods now live in user-state anyway).
fn is_mood_only_patch(patch: &serde_json::Value) -> bool {
    patch
        .as_object()
        .is_some_and(|o| !o.is_empty() && o.keys().all(|k| k == "mood" || k == "moods"))
}

async fn track_lyrics_fetch(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<TrackFetchBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = match resolve_track_rel(&state, body.rel_path, body.track_id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    match metadata::track_lyrics_fetch(&root, &state.db, &rel).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Missing artist") {
                err_detail(StatusCode::BAD_REQUEST, "lyrics_missing_artist", msg)
            } else if msg.contains("not found") {
                err_detail(StatusCode::NOT_FOUND, "lyrics_not_found", msg)
            } else {
                meta_err(e, "lyrics_fetch_failed", StatusCode::BAD_GATEWAY)
            }
        }
    }
}

async fn track_info_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<TrackSaveBody>,
) -> Response {
    if is_mood_only_patch(&body.patch) {
        // Moods are account state (user-state `trackMoods`), not track
        // metadata: `TrackMetaPatch` has no mood field, so going on would only
        // stamp `source = manual` into the sidecar and DB for an unprivileged
        // caller. Accept the legacy shape without touching the library.
        return ok(json!({ "ok": true, "saved": false })).into_response();
    }
    library_op_or_return!(&state, &headers, &q, peer);
    let patch: TrackMetaPatch = match serde_json::from_value(body.patch) {
        Ok(p) => p,
        Err(e) => return err_detail(StatusCode::BAD_REQUEST, "invalid_patch", e),
    };
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = match resolve_track_rel(&state, body.rel_path, body.track_id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let db = state.db.clone();
    let res = blocking(move || metadata::track_info_save(&root, &db, &rel, patch)).await;
    match res {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "track_info_save_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneOrphansBody {
    album_path: Option<String>,
    album_id: Option<i64>,
}

async fn track_info_prune_orphans(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<PruneOrphansBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    match blocking(move || metadata::prune_album_library_metadata(&root, &path)).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "prune_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizeTitlesBody {
    scope: Option<String>,
    album_path: Option<String>,
    dry_run: Option<bool>,
}

async fn sanitize_track_titles(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<SanitizeTitlesBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let scope = body.scope.unwrap_or_else(|| "album".into());
    let dry_run = body.dry_run.unwrap_or(true);
    let album_path = body.album_path;
    let db = state.db.clone();
    let res = blocking(move || {
        metadata::sanitize_track_titles(&root, &db, &scope, album_path.as_deref(), dry_run)
    })
    .await;
    match res {
        Ok(v) => ok(v).into_response(),
        Err(e) => meta_err(e, "sanitize_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
struct DiscogsSearchBody {
    artist: String,
    album: String,
}

async fn discogs_search(
    State(state): State<AppState>,
    Json(body): Json<DiscogsSearchBody>,
) -> Response {
    let cfg = state.config.lock_or_recover().clone();
    match metadata::discogs_search(&cfg, &body.artist, &body.album).await {
        Ok(candidates) => ok(json!({ "ok": true, "candidates": candidates })).into_response(),
        Err(e) => meta_err(e, "discogs_search_failed", StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscogsApplyBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    release_id: i64,
    artist: Option<String>,
    album: Option<String>,
}

async fn discogs_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<DiscogsApplyBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let cfg = state.config.lock_or_recover().clone();
    match metadata::discogs_apply(
        &cfg,
        &root,
        &state.db,
        &path,
        body.release_id,
        body.artist.as_deref(),
        body.album.as_deref(),
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => meta_err(e, "discogs_apply_failed", StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitySearchBody {
    artist: String,
    album: Option<String>,
    lang: Option<String>,
    /// Folder names (when the display names differ), to mark saved items.
    folder_artist: Option<String>,
    folder_album: Option<String>,
}

fn entity_search_options(
    state: &AppState,
    artist: &str,
    album: Option<&str>,
    lang: Option<&str>,
) -> EntitySearchOptions {
    let cfg = state.config.lock_or_recover();
    EntitySearchOptions {
        artist: artist.trim().to_string(),
        album: album
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string),
        lang: lang
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or("it")
            .to_string(),
        discogs_token: cfg.discogs_token.clone(),
        lastfm_key: None,
        max_candidates: None,
    }
}

/// Candidates from Wikipedia / Wikiquote / Last.fm / TheAudioDB / Discogs,
/// already-saved ones flagged; per-source failures in `errors`.
async fn entity_info_search(
    State(state): State<AppState>,
    Json(body): Json<EntitySearchBody>,
) -> Response {
    let opts = entity_search_options(
        &state,
        &body.artist,
        body.album.as_deref(),
        body.lang.as_deref(),
    );
    let root = state.config.lock_or_recover().music_root.clone();
    match entity_info::search_entity_info(
        root.as_deref(),
        &opts,
        body.folder_artist.as_deref(),
        body.folder_album.as_deref().or(body.album.as_deref()),
    )
    .await
    {
        Ok(res) => ok(res).into_response(),
        Err(e) => meta_err(e, "entity_info_search_failed", StatusCode::BAD_GATEWAY),
    }
}

async fn entity_info_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<EntityInfoSaveRequest>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    // Untrusted `imageUrl`: public hosts only, streamed with a size cap.
    match entity_info::save_entity_info_full(&root, body).await {
        Ok(bundle) => ok(bundle).into_response(),
        Err(e) => meta_err(e, "entity_info_save_failed", StatusCode::BAD_REQUEST),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityBatchBody {
    artist: String,
    /// `artist` (artist + every album folder) or `albums` (with `albums`).
    scope: Option<String>,
    albums: Option<Vec<String>>,
    lang: Option<String>,
    /// NDJSON: `progress` lines, then `done` with the result.
    stream: Option<bool>,
}

#[allow(clippy::result_large_err)]
fn batch_scope(body: &EntityBatchBody) -> Result<entity_info::BatchScope, Response> {
    match body.scope.as_deref().unwrap_or("artist") {
        "artist" => Ok(entity_info::BatchScope::Artist),
        "albums" => Ok(entity_info::BatchScope::Albums(
            body.albums.clone().unwrap_or_default(),
        )),
        _ => Err(err(StatusCode::BAD_REQUEST, "invalid_scope")),
    }
}

/// Run a batch with optional NDJSON progress (`{type:"progress",done,total,key}`
/// then `{type:"done", ok, data|error}`).
async fn run_entity_batch<T, F, Fut>(stream: bool, run: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(Arc<dyn Fn(entity_info::BatchProgress) + Send + Sync>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = anyhow::Result<T>> + Send + 'static,
{
    if !stream {
        let noop: Arc<dyn Fn(entity_info::BatchProgress) + Send + Sync> = Arc::new(|_| {});
        return match run(noop).await {
            Ok(v) => ok(v).into_response(),
            Err(e) => meta_err(e, "entity_info_batch_failed", StatusCode::BAD_GATEWAY),
        };
    }
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let progress_tx = tx.clone();
    let on_progress: Arc<dyn Fn(entity_info::BatchProgress) + Send + Sync> =
        Arc::new(move |p: entity_info::BatchProgress| {
            let mut v = serde_json::to_value(&p).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("type".into(), json!("progress"));
            }
            let _ = progress_tx.send(v.to_string());
        });
    tokio::spawn(async move {
        let line = match run(on_progress).await {
            Ok(v) => json!({ "type": "done", "ok": true, "data": v }),
            Err(e) => {
                let (_, code, message) = crate::metadata::error::classify(&e);
                let code = if code == "internal_error" {
                    "entity_info_batch_failed"
                } else {
                    code
                };
                json!({ "type": "done", "ok": false, "error": code, "message": message })
            }
        };
        let _ = tx.send(line.to_string());
    });
    let body = tokio_stream::wrappers::UnboundedReceiverStream::new(rx)
        .map(|line| Ok::<_, Infallible>(Bytes::from(format!("{line}\n"))));
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, Body::from_stream(body)).into_response()
}

/// Targets of a batch (artist row + album folders, with display labels).
async fn entity_info_batch_targets(
    State(state): State<AppState>,
    Json(body): Json<EntityBatchBody>,
) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let scope = match batch_scope(&body) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let db = state.db.clone();
    let artist = body.artist.clone();
    match blocking(move || entity_info::batch_targets(&root, Some(&db), &artist, &scope)).await {
        Ok(targets) => ok(json!({ "targets": targets })).into_response(),
        Err(e) => meta_err(e, "entity_info_batch_failed", StatusCode::BAD_REQUEST),
    }
}

/// Search curiosità for an artist and its albums (scope `artist`) or chosen
/// albums; nothing is written.
async fn entity_info_batch_search(
    State(state): State<AppState>,
    Json(body): Json<EntityBatchBody>,
) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let scope = match batch_scope(&body) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let opts = entity_search_options(&state, &body.artist, None, body.lang.as_deref());
    let db = state.db.clone();
    let artist = body.artist.clone();
    run_entity_batch(body.stream.unwrap_or(false), move |progress| async move {
        let rows = entity_info::batch_search_entity_info(
            &root,
            Some(&db),
            &artist,
            &scope,
            &opts,
            progress.as_ref(),
        )
        .await?;
        Ok(json!({ "rows": rows }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityBatchSaveBody {
    artist: String,
    rows: Vec<entity_info::BatchSaveRow>,
}

/// Save reviewed candidates for several targets of one artist.
async fn entity_info_batch_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<EntityBatchSaveBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    match entity_info::batch_save_entity_info(&root, &body.artist, body.rows).await {
        Ok(results) => ok(json!({ "results": results })).into_response(),
        Err(e) => meta_err(e, "entity_info_save_failed", StatusCode::BAD_REQUEST),
    }
}

/// Search and save in one go (every new candidate of every target).
async fn entity_info_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Json(body): Json<EntityBatchBody>,
) -> Response {
    library_op_or_return!(&state, &headers, &q, peer);
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let scope = match batch_scope(&body) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let opts = entity_search_options(&state, &body.artist, None, body.lang.as_deref());
    let db = state.db.clone();
    let artist = body.artist.clone();
    run_entity_batch(body.stream.unwrap_or(false), move |progress| async move {
        let results = entity_info::batch_search_and_save_entity_info(
            &root,
            Some(&db),
            &artist,
            &scope,
            &opts,
            progress.as_ref(),
        )
        .await?;
        Ok(json!({ "results": results }))
    })
    .await
}
