use crate::entity_info;
use crate::perm::PeerAddr;
use crate::selection::{self, CatalogKeys, LibrarySelection, SelectionFilterMode, SelectionPatch};
use crate::state::AppState;
use crate::sync::LockRecover;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

macro_rules! account_or_err {
    ($state:expr, $headers:expr, $q:expr) => {
        match resolve_account($state, $headers, $q) {
            Ok(id) => id,
            Err(r) => return r,
        }
    };
}

/// Loopback / Default-account gate for host-level writes.
macro_rules! machine_op_or_err {
    ($state:expr, $headers:expr, $peer:expr) => {
        match crate::perm::require_machine_op($state, $headers, None, $peer) {
            Ok(op) => op,
            Err(response) => return response,
        }
    };
}

/// Registry changes need host access (legacy: server admin, any account).
macro_rules! host_op_or_err {
    ($state:expr, $headers:expr, $peer:expr) => {
        if let Err(response) = crate::perm::require_host_op($state, $headers, $peer) {
            return response;
        }
    };
}

mod accounts;
mod backup;
mod library;
mod personal;
mod system;

use accounts::*;
use backup::*;
use library::*;
use personal::*;
use system::*;

// Request bodies shared by more than one module (sibling modules cannot see
// each other's private fields).
#[derive(Deserialize)]
pub(super) struct NameBody {
    pub(super) name: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/events", get(crate::events::sse))
        .route("/api/health", get(health))
        .route("/api/v1/library", get(library_index))
        .route("/api/v1/library/stats", get(library_stats))
        .route("/api/v1/library/search", get(library_search))
        .route("/api/v1/library/genres", get(library_genres))
        .route("/api/v1/library/albums", get(list_albums))
        .route("/api/v1/library/albums/{id}", get(get_album))
        .route("/api/v1/library/albums/{id}/tracks", get(album_tracks))
        .route("/api/v1/library/tracks-page", get(tracks_page))
        .route("/api/v1/library/artists-page", get(artists_page))
        .route("/api/v1/library/changes", get(library_changes))
        .route("/api/v1/library/artists", get(list_artists))
        .route("/api/v1/library/artists/{id}", get(get_artist))
        .route("/api/v1/library/artists/{id}/albums", get(artist_albums))
        .route("/api/v1/library/tracks/{id}", get(get_track))
        .route(
            "/api/v1/library/path",
            get(get_music_path).put(set_music_path),
        )
        .route("/api/v1/library/scan", post(run_scan))
        .route("/api/v1/library/probe", post(probe_library))
        .route(
            "/api/v1/library/layout",
            get(get_library_layout).put(set_library_layout),
        )
        .route("/api/v1/library/watch", get(get_watch).put(set_watch))
        .route("/api/v1/library/thumbnails", post(run_thumbnail_backfill))
        .route(
            "/api/v1/library/embedded",
            get(get_embedded).put(set_embedded),
        )
        .route("/api/v1/library/embedded/reread", post(reread_embedded))
        .route("/api/v1/network/public-ip", get(get_public_ip))
        .route("/api/network/public-ip", get(get_public_ip))
        .route(
            "/api/v1/system/access-key",
            get(get_access_key)
                .put(set_access_key)
                .delete(clear_access_key),
        )
        .route(
            "/api/v1/system/machine-access",
            get(get_machine_access).put(set_machine_access),
        )
        .route("/api/v1/library/sync-legacy-meta", post(sync_legacy_meta))
        .route(
            "/api/v1/legacy-import",
            get(get_legacy_import).post(sync_legacy_meta),
        )
        .route("/api/v1/favorites", get(list_favorites).post(add_favorite))
        .route("/api/v1/favorites/{id}", delete(remove_favorite))
        .route(
            "/api/v1/playlists",
            get(list_playlists).post(create_playlist),
        )
        .route(
            "/api/v1/playlists/{id}",
            get(get_playlist)
                .put(rename_playlist)
                .delete(delete_playlist),
        )
        .route(
            "/api/v1/playlists/{id}/tracks",
            post(add_playlist_track)
                .put(reorder_playlist_tracks)
                .delete(remove_playlist_track),
        )
        .route("/api/v1/modules", get(list_modules))
        .route("/api/v1/entity-info", get(get_entity_info))
        .route("/api/entity-info", get(get_entity_info))
        .route("/api/v1/backup/kord-data", get(download_backup))
        .route("/api/backup/kord-data", get(download_backup))
        .route("/api/backup/rekord-data", get(download_backup))
        .route("/api/v1/backup/theme-export", get(download_theme_export))
        .route("/api/backup/theme-export", get(download_theme_export))
        .route(
            "/api/v1/backup/kord-restore",
            post(upload_restore).layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route(
            "/api/backup/kord-restore",
            post(upload_restore).layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route(
            "/api/backup/rekord-restore",
            post(upload_restore).layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route(
            "/api/v1/my-library-selection",
            get(get_my_library_selection).patch(patch_my_library_selection),
        )
        .route(
            "/api/my-library-selection",
            get(get_my_library_selection).patch(patch_my_library_selection),
        )
        .route("/api/v1/catalog", get(get_catalog))
        .route("/api/catalog", get(get_catalog))
        .route("/api/v1/accounts", get(list_accounts).post(create_account))
        .route("/api/accounts", get(list_accounts).post(create_account))
        .route(
            "/api/v1/accounts/{id}",
            put(update_account).delete(delete_account),
        )
        .route(
            "/api/accounts/{id}",
            put(update_account).delete(delete_account),
        )
        .route("/api/v1/accounts/{id}/export", get(export_account_profile))
        .route("/api/accounts/{id}/export", get(export_account_profile))
}

fn data_dir(state: &AppState) -> PathBuf {
    state.config.lock_or_recover().data_dir.clone()
}

#[derive(Debug, Deserialize, Default)]
struct AccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

/// Request account (query / header), validated: malformed → 400, unknown → 404.
#[allow(clippy::result_large_err)]
fn resolve_account(
    state: &AppState,
    headers: &HeaderMap,
    q: &AccountQuery,
) -> Result<String, Response> {
    let dir = data_dir(state);
    crate::accounts::account_from_request(&dir, headers, q.account_id.as_deref())
        .map_err(|e| err(e.status(), e.code()))
}

fn load_selection(state: &AppState, account_id: &str) -> Result<LibrarySelection, String> {
    selection::read_library_selection(&data_dir(state), account_id).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Envelope<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope {
        ok: true,
        data: Some(data),
        error: None,
    })
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = Json(Envelope::<()> {
        ok: false,
        data: None,
        error: Some(msg.into()),
    });
    (status, body).into_response()
}

/// 500 with the stable `internal_error` code and the error text as detail.
fn internal(e: impl std::fmt::Display) -> Response {
    err_code(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        e.to_string(),
    )
}

/// Stable `snake_case` code plus an untranslated detail (`message`).
fn err_code(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": code, "message": message.into() })),
    )
        .into_response()
}

/// HTTP API contract version advertised by `/health` (bump on breaking changes).
pub const API_VERSION: u32 = 1;

/// Oldest client release this hub still talks to.
pub const MIN_CLIENT_VERSION: &str = "5.0.0";

/// Module ids clients may rely on: manifest flags plus the modules switched
/// on from the admin panel (`podcasts`).
fn enabled_modules(state: &AppState) -> Vec<String> {
    let mut ids: Vec<String> = state
        .modules
        .enabled_ids()
        .into_iter()
        .map(str::to_string)
        .collect();
    if crate::podcasts::enabled(state) {
        ids.push("podcasts".into());
    }
    ids
}

async fn health(
    State(state): State<AppState>,
    access: Option<axum::Extension<crate::access_key::Access>>,
) -> impl IntoResponse {
    let access_key = crate::access_key::health_access(&state, access.map(|e| e.0));
    // Without the key: only what a client needs to ask for one and to tell
    // whether it can talk to this hub at all.
    if access_key == "required" {
        return Json(json!({
            "ok": true,
            "service": "RE-KORD",
            "apiVersion": API_VERSION,
            "minClientVersion": MIN_CLIENT_VERSION,
            "accessKey": access_key,
        }));
    }
    Json(json!({
        "ok": true,
        "service": "RE-KORD",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "minClientVersion": MIN_CLIENT_VERSION,
        "transcode": crate::transcode::ffmpeg_available(),
        "modules": enabled_modules(&state),
        "scanning": state.is_scanning(),
        "accessKey": access_key,
    }))
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn get_public_ip() -> impl IntoResponse {
    match crate::remote_access::resolve_public_ip().await {
        Some(ip) => ok(json!({ "ip": ip })).into_response(),
        None => ok(json!({ "ip": serde_json::Value::Null })).into_response(),
    }
}

async fn list_modules(State(state): State<AppState>) -> impl IntoResponse {
    let mut registry = state.modules.as_ref().clone();
    registry.modules.push(rekord_plugin_api::ModuleManifest {
        id: "podcasts".into(),
        name: "Podcast e notizie".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        description: "Podcasts, news bulletins and live radio (enabled in the admin panel)".into(),
        enabled: crate::podcasts::enabled(&state),
    });
    ok(registry)
}
