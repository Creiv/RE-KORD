use crate::accounts;
use crate::backup;
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

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(health))
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
    accounts::account_from_request(&dir, headers, q.account_id.as_deref())
        .map_err(|e| err(e.status(), e.code()))
}

macro_rules! account_or_err {
    ($state:expr, $headers:expr, $q:expr) => {
        match resolve_account($state, $headers, $q) {
            Ok(id) => id,
            Err(r) => return r,
        }
    };
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
struct ListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn library_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    // Import legacy / full catalog may need large pages; keep a sane upper bound.
    let limit = q.limit.unwrap_or(500).clamp(1, 50_000);
    let offset = q.offset.unwrap_or(0).max(0);
    let account_id = match resolve_account(
        &state,
        &headers,
        &AccountQuery {
            account_id: q.account_id.clone(),
        },
    ) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match selection::get_selection_filter_mode(&sel) {
        SelectionFilterMode::Empty => ok(Vec::<crate::db::LibraryTrack>::new()).into_response(),
        SelectionFilterMode::All => match state.db.list_library_tracks(limit, offset) {
            Ok(tracks) => ok(tracks).into_response(),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        // Filter after a full fetch so limit/offset apply to the personal library, not the FS page.
        SelectionFilterMode::Filter => {
            match (
                state.db.list_library_tracks(50_000, 0),
                state.db.list_albums(),
            ) {
                (Ok(tracks), Ok(albums)) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    let page: Vec<_> = tracks
                        .into_iter()
                        .skip(offset as usize)
                        .take(limit as usize)
                        .collect();
                    ok(page).into_response()
                }
                (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
    }
}

/// Paginated personal-library tracks. Total is the selection-filtered count, so
/// clients can page without holding the whole catalog in memory.
async fn tracks_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(500).clamp(1, 5_000);
    let offset = q.offset.unwrap_or(0).max(0);
    let account_id = match resolve_account(
        &state,
        &headers,
        &AccountQuery {
            account_id: q.account_id.clone(),
        },
    ) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match selection::get_selection_filter_mode(&sel) {
        SelectionFilterMode::Empty => ok(json!({
            "items": Vec::<crate::db::LibraryTrack>::new(),
            "total": 0,
            "limit": limit,
            "offset": offset,
        }))
        .into_response(),
        SelectionFilterMode::All => {
            match (
                state.db.list_library_tracks(limit, offset),
                state.db.count_tracks(),
            ) {
                (Ok(items), Ok(total)) => ok(json!({
                    "items": items,
                    "total": total,
                    "limit": limit,
                    "offset": offset,
                }))
                .into_response(),
                (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        SelectionFilterMode::Filter => {
            match (
                state.db.list_library_tracks(i64::MAX, 0),
                state.db.list_albums(),
            ) {
                (Ok(tracks), Ok(albums)) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    let total = tracks.len() as i64;
                    let items: Vec<_> = tracks
                        .into_iter()
                        .skip(offset as usize)
                        .take(limit as usize)
                        .collect();
                    ok(json!({
                        "items": items,
                        "total": total,
                        "limit": limit,
                        "offset": offset,
                    }))
                    .into_response()
                }
                (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
    }
}

async fn artists_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(200).clamp(1, 5_000);
    let offset = q.offset.unwrap_or(0).max(0);
    let account_id = match resolve_account(
        &state,
        &headers,
        &AccountQuery {
            account_id: q.account_id.clone(),
        },
    ) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match (state.db.list_artists(), state.db.list_albums()) {
        (Ok(artists), Ok(albums)) => {
            let visible = match selection::get_selection_filter_mode(&sel) {
                SelectionFilterMode::Empty => Vec::new(),
                SelectionFilterMode::All => artists,
                SelectionFilterMode::Filter => {
                    let allowed = selection::filter_albums(albums, &sel);
                    artists
                        .into_iter()
                        .filter(|a| allowed.iter().any(|al| al.artist_id == Some(a.id)))
                        .collect()
                }
            };
            let total = visible.len() as i64;
            let items: Vec<_> = visible
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect();
            ok(json!({
                "items": items,
                "total": total,
                "limit": limit,
                "offset": offset,
            }))
            .into_response()
        }
        (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize, Default)]
struct ChangesQuery {
    /// RFC3339 cursor from a previous response (`revision`).
    since: Option<String>,
    limit: Option<i64>,
}

/// Delta since a revision cursor: updated tracks + removed rel paths.
async fn library_changes(
    State(state): State<AppState>,
    Query(q): Query<ChangesQuery>,
) -> impl IntoResponse {
    let revision = match state.db.library_revision() {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let limit = q.limit.unwrap_or(2_000).clamp(1, 10_000);
    let Some(since) = q.since.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        // No cursor: tell the client to do a full page-through.
        return ok(json!({
            "revision": revision,
            "full": true,
            "updated": Vec::<crate::db::LibraryTrack>::new(),
            "removed": Vec::<String>::new(),
        }))
        .into_response();
    };
    match state.db.tracks_changed_since(since, limit) {
        Ok((updated, removed)) => {
            let truncated = updated.len() as i64 >= limit || removed.len() as i64 >= limit;
            ok(json!({
                "revision": revision,
                "full": truncated,
                "updated": updated,
                "removed": removed,
                "scanning": state.is_scanning(),
            }))
            .into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Library counters. With an account (query / header) the counts follow that
/// account's library selection, like every list endpoint; `catalog_track_count`
/// is always the whole indexed catalog.
async fn library_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let music_root_path = state.config.lock_or_recover().music_root.clone();
    let music_root = music_root_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let db = state.db.clone();
    let computed = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let mut stats = db.stats(music_root)?;
        if selection::get_selection_filter_mode(&sel) != SelectionFilterMode::All {
            let albums = db.list_albums()?;
            let tracks = db.list_library_tracks(i64::MAX, 0)?;
            let artist_count = stats.artist_count;
            selection::selection_stats(&albums, &tracks, artist_count, &sel, &mut stats);
        }
        Ok(stats)
    })
    .await;
    match computed {
        Ok(Ok(mut stats)) => {
            stats.scanning = state.is_scanning();
            if let Some(root) = music_root_path.as_ref() {
                if let Some(space) = crate::disk_space::volume_space(root) {
                    stats.disk_total_bytes = Some(space.total_bytes);
                    stats.disk_available_bytes = Some(space.available_bytes);
                }
            }
            ok(stats).into_response()
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Canonical genres of the account's library with track / album / artist
/// counts, most common first.
async fn library_genres(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let db = state.db.clone();
    let computed = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let tracks = db.list_library_tracks(i64::MAX, 0)?;
        let tracks = match selection::get_selection_filter_mode(&sel) {
            SelectionFilterMode::All => tracks,
            _ => {
                let albums = selection::filter_albums(db.list_albums()?, &sel);
                selection::filter_tracks(tracks, &albums, &sel)
            }
        };
        Ok(crate::db::count_genres(
            tracks
                .iter()
                .map(|t| (t.genres.as_slice(), t.album_id, t.artist_id)),
        ))
    })
    .await;
    match computed {
        Ok(Ok(list)) => ok(list).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<i64>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    /// `all`: `{ tracks, albums, artists }` instead of the bare track list.
    scope: Option<String>,
}

/// Track search (FTS over title, artist, album and genre; accents ignored;
/// file paths never match). `scope=all` also returns albums and artists
/// matching by name or genre.
async fn library_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let account_id = account_or_err!(
        &state,
        &headers,
        &AccountQuery {
            account_id: q.account_id.clone(),
        }
    );
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let all_scope = q.scope.as_deref().map(str::trim) == Some("all");
    let mode = selection::get_selection_filter_mode(&sel);
    if mode == SelectionFilterMode::Empty {
        return if all_scope {
            ok(json!({ "tracks": [], "albums": [], "artists": [] })).into_response()
        } else {
            ok(Vec::<crate::db::LibraryTrack>::new()).into_response()
        };
    }
    let db = state.db.clone();
    let query = q.q.clone();
    let computed = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        // Over-fetch then clip so personal selection does not starve the result page.
        let fetch = if mode == SelectionFilterMode::All {
            limit
        } else {
            (limit.saturating_mul(20)).clamp(limit, 2_000)
        };
        let tracks = db.search_tracks(&query, fetch)?;
        let (albums, artists) = if all_scope {
            db.search_albums_artists(&query)?
        } else {
            (Vec::new(), Vec::new())
        };
        if mode == SelectionFilterMode::All {
            return Ok((tracks, albums, artists));
        }
        let visible = selection::filter_albums(db.list_albums()?, &sel);
        let mut tracks = selection::filter_tracks(tracks, &visible, &sel);
        tracks.truncate(limit as usize);
        let albums = selection::filter_albums(albums, &sel);
        let visible_artists: std::collections::HashSet<i64> =
            visible.iter().filter_map(|a| a.artist_id).collect();
        let artists = artists
            .into_iter()
            .filter(|a| visible_artists.contains(&a.id))
            .collect();
        Ok((tracks, albums, artists))
    })
    .await;
    match computed {
        Ok(Ok((tracks, albums, artists))) => {
            if all_scope {
                ok(json!({ "tracks": tracks, "albums": albums, "artists": artists }))
                    .into_response()
            } else {
                ok(tracks).into_response()
            }
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_albums(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match state.db.list_albums() {
        Ok(v) => ok(selection::filter_albums(v, &sel)).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn album_tracks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    if selection::get_selection_filter_mode(&sel) != SelectionFilterMode::All {
        match state.db.get_album(id) {
            Ok(Some(al)) => {
                let filtered = selection::filter_albums(vec![al], &sel);
                if filtered.is_empty() {
                    return err(StatusCode::NOT_FOUND, "album not found");
                }
            }
            Ok(None) => return err(StatusCode::NOT_FOUND, "album not found"),
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }
    match state.db.library_album_tracks(id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_artists(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match (
        state.db.list_artists(),
        state.db.list_albums(),
        state.db.list_tracks(50_000, 0),
    ) {
        (Ok(artists), Ok(albums), Ok(tracks)) => {
            let albums = selection::filter_albums(albums, &sel);
            let tracks = selection::filter_tracks(tracks, &albums, &sel);
            ok(selection::filter_artists(artists, &albums, &tracks, &sel)).into_response()
        }
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
            err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}

async fn get_artist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match state.db.get_artist(id) {
        Ok(Some(a)) => {
            if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::All {
                return ok(a).into_response();
            }
            match (state.db.list_albums(), state.db.list_tracks(50_000, 0)) {
                (Ok(albums), Ok(tracks)) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    let filtered = selection::filter_artists(vec![a], &albums, &tracks, &sel);
                    match filtered.into_iter().next() {
                        Some(a) => ok(a).into_response(),
                        None => err(StatusCode::NOT_FOUND, "artist not found"),
                    }
                }
                (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "artist not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn artist_albums(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match state.db.artist_albums(id) {
        Ok(v) => ok(selection::filter_albums(v, &sel)).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match state.db.get_album(id) {
        Ok(Some(a)) => {
            let filtered = selection::filter_albums(vec![a], &sel);
            match filtered.into_iter().next() {
                Some(a) => ok(a).into_response(),
                None => err(StatusCode::NOT_FOUND, "album not found"),
            }
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "album not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match state.db.get_library_track(id) {
        Ok(Some(t)) => {
            if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::All {
                return ok(t).into_response();
            }
            match state.db.list_albums() {
                Ok(albums) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let filtered = selection::filter_tracks(vec![t], &albums, &sel);
                    match filtered.into_iter().next() {
                        Some(t) => ok(t).into_response(),
                        None => err(StatusCode::NOT_FOUND, "track not found"),
                    }
                }
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "track not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_music_path(State(state): State<AppState>) -> impl IntoResponse {
    let root = state
        .config
        .lock_or_recover()
        .music_root
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    ok(json!({ "music_root": root }))
}

#[derive(Deserialize)]
struct SetPathBody {
    music_root: String,
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

async fn set_music_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<SetPathBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let path = PathBuf::from(body.music_root.trim());
    if !path.is_dir() {
        return err(StatusCode::BAD_REQUEST, "music_root is not a directory");
    }
    // Drop the config guard before needs_initial_scan (it locks again).
    if let Err(e) = state.config.lock_or_recover().save_music_root(path.clone()) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    // First-time path (or never indexed): index in background so admin
    // "save path" is enough — no separate scan click required.
    if state.needs_initial_scan() {
        state.spawn_initial_scan_if_needed();
    }
    // Re-arm the watcher on the new root.
    crate::watcher::start(&state);
    ok(json!({ "music_root": path })).into_response()
}

#[derive(Deserialize, Default)]
struct ScanQuery {
    /// `incremental` (default) or `full`.
    mode: Option<String>,
}

async fn run_scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ScanQuery>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.is_scanning() {
        return err(StatusCode::CONFLICT, "scan already in progress");
    }
    let mode = crate::scan::ScanMode::from_query(q.mode.as_deref());
    match state.run_scan_mode(mode).await {
        Ok(report) => ok(report).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("music_root not set") {
                err(StatusCode::BAD_REQUEST, msg)
            } else if msg.contains("already in progress") {
                err(StatusCode::CONFLICT, msg)
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        }
    }
}

#[derive(Deserialize, Default)]
struct ProbeQuery {
    #[serde(rename = "sampleLimit")]
    sample_limit: Option<u64>,
}

/// Analyse the folder structure without touching the DB (setup helper). A
/// machine operation like the layout it feeds: it walks the music folder.
async fn probe_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ProbeQuery>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return err(StatusCode::BAD_REQUEST, "music_root not set");
    };
    let limit = q.sample_limit.unwrap_or(200);
    match tokio::task::spawn_blocking(move || crate::layout::probe_structure(&root, limit)).await {
        Ok(report) => ok(report).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_library_layout(State(state): State<AppState>) -> impl IntoResponse {
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return ok(crate::layout::LibraryLayout::default()).into_response();
    };
    ok(crate::layout::load_layout(&root)).into_response()
}

async fn set_library_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<crate::layout::LibraryLayout>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return err(StatusCode::BAD_REQUEST, "music_root not set");
    };
    match crate::layout::save_layout(&root, &body) {
        Ok(()) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "library",
                    "layout",
                    format!("layout impostato: {}", body.preferred_layout.as_str()),
                )
                .params(json!({ "layout": body.preferred_layout.as_str() })),
            );
            ok(body).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_watch(State(state): State<AppState>) -> impl IntoResponse {
    let enabled = state.config.lock_or_recover().watch_library;
    ok(state.watcher.status(enabled))
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn set_watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<EnabledBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if let Err(e) = state
        .config
        .lock_or_recover()
        .save_watch_library(body.enabled)
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if body.enabled {
        crate::watcher::start(&state);
    } else {
        crate::watcher::stop(&state);
    }
    crate::diagnostics::log_activity(
        &data_dir(&state),
        if body.enabled {
            crate::diagnostics::ActivityEvent::new(
                "library",
                "watchOn",
                "watcher libreria attivato",
            )
        } else {
            crate::diagnostics::ActivityEvent::new(
                "library",
                "watchOff",
                "watcher libreria disattivato",
            )
        },
    );
    ok(state.watcher.status(body.enabled)).into_response()
}

/// Kick off (or re-run) the cover thumbnail backfill as a job.
async fn run_thumbnail_backfill(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let bg = state.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::thumbs::run_backfill(bg).await {
            tracing::warn!(error = %e, "thumbnail backfill failed");
        }
    });
    ok(json!({ "started": true })).into_response()
}

async fn get_embedded(State(state): State<AppState>) -> Response {
    match crate::embedded::backfill::status(&state) {
        Ok(s) => ok(s).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBody {
    enabled: Option<bool>,
    priority: Option<String>,
    embed_downloads: Option<bool>,
}

/// "Leggi metadati e copertine incorporati" and its priority. A change
/// re-reads the library in the background (the backfill job).
async fn set_embedded(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<EmbeddedBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let current = state.config.lock_or_recover().embedded;
    let mut next = current;
    if let Some(enabled) = body.enabled {
        next.enabled = enabled;
    }
    if let Some(raw) = body.priority.as_deref() {
        match crate::embedded::EmbeddedPriority::parse(raw) {
            Some(p) => next.priority = p,
            None => return err(StatusCode::BAD_REQUEST, "invalid_embedded_priority"),
        }
    }
    if let Some(embed) = body.embed_downloads {
        next.embed_downloads = embed;
    }
    if next != current {
        if let Err(e) = state.config.lock_or_recover().save_embedded_settings(next) {
            tracing::warn!(error = %e, "could not save embedded metadata settings");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "settings_save_failed");
        }
    }
    if next.embed_downloads != current.embed_downloads {
        crate::diagnostics::log_activity(
            &data_dir(&state),
            crate::diagnostics::ActivityEvent::new(
                "library",
                "downloadTagsSettings",
                format!(
                    "tag e copertina nei download: {}",
                    if next.embed_downloads {
                        "attivi"
                    } else {
                        "spenti"
                    }
                ),
            )
            .params(json!({ "embedDownloads": next.embed_downloads })),
        );
    }
    // Reading settings changed: re-read the library.
    if next.enabled != current.enabled || next.priority != current.priority {
        state.db.set_prefer_embedded(
            next.enabled && next.priority == crate::embedded::EmbeddedPriority::Embedded,
        );
        if let Err(e) = crate::embedded::backfill::request_reread(&state, false) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        crate::diagnostics::log_activity(
            &data_dir(&state),
            crate::diagnostics::ActivityEvent::new(
                "library",
                "embeddedSettings",
                format!(
                    "metadati incorporati: {}, priorità {}",
                    if next.enabled { "attivi" } else { "spenti" },
                    next.priority.as_str()
                ),
            )
            .params(json!({ "enabled": next.enabled, "priority": next.priority.as_str() })),
        );
    }
    get_embedded(State(state)).await
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RereadBody {
    /// With the embedded priority: tag values also replace typed values.
    #[serde(default)]
    override_studio: bool,
}

/// "Rileggi metadati incorporati": refresh every value that came from the
/// tags (and embedded covers) as a background job.
async fn reread_embedded(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    body: Option<Json<RereadBody>>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let settings = state.config.lock_or_recover().embedded;
    let override_studio = body.override_studio
        && settings.enabled
        && settings.priority == crate::embedded::EmbeddedPriority::Embedded;
    if let Err(e) = crate::embedded::backfill::request_reread(&state, override_studio) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    crate::diagnostics::log_activity(
        &data_dir(&state),
        crate::diagnostics::ActivityEvent::new(
            "library",
            "embeddedReread",
            "rilettura dei metadati incorporati avviata",
        )
        .params(json!({ "overrideStudio": override_studio })),
    );
    get_embedded(State(state)).await
}

/// What the caller is allowed to do with host-level settings.
async fn get_machine_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> impl IntoResponse {
    ok(crate::perm::machine_op_status(&state, &headers, None, peer))
}

/// Allow machine operations from remote clients. Only settable locally.
async fn set_machine_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<EnabledBody>,
) -> Response {
    let op = machine_op_or_err!(&state, &headers, peer);
    if !op.local {
        return crate::perm::forbidden(crate::perm::FORBIDDEN_REMOTE);
    }
    if let Err(e) = state
        .config
        .lock_or_recover()
        .save_allow_remote_admin(body.enabled)
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    crate::diagnostics::log_activity(
        &data_dir(&state),
        if body.enabled {
            crate::diagnostics::ActivityEvent::new(
                "system",
                "remoteAdminOn",
                "operazioni di macchina abilitate da remoto",
            )
        } else {
            crate::diagnostics::ActivityEvent::new(
                "system",
                "remoteAdminOff",
                "operazioni di macchina limitate al computer dell'hub",
            )
        },
    );
    ok(crate::perm::machine_op_status(&state, &headers, None, peer)).into_response()
}

/// Whether the hub asks for an access key, and where that key comes from.
fn access_key_status(state: &AppState) -> serde_json::Value {
    let source = state.access_key.source();
    json!({
        "enabled": source.is_some(),
        "source": source.map(|s| s.as_str()).unwrap_or("off"),
        // `REKORD_ACCESS_KEY` wins: the panel can look but not change.
        "lockedByEnv": source == Some(crate::access_key::KeySource::Env),
    })
}

async fn get_access_key(State(state): State<AppState>) -> impl IntoResponse {
    ok(access_key_status(&state))
}

#[derive(Deserialize)]
struct AccessKeyBody {
    key: String,
}

/// Set or replace the access key from the admin panel (machine operation).
/// The key is validated like `REKORD_ACCESS_KEY`, only its digest is saved,
/// and every client (this panel included) must present it from now on.
async fn set_access_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<AccessKeyBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.access_key.locked_by_env() {
        return err_code(
            StatusCode::CONFLICT,
            "access_key_from_env",
            "the access key is set by REKORD_ACCESS_KEY; change it there",
        );
    }
    let gate = match crate::access_key::AccessGate::from_user_input(body.key.trim()) {
        Ok(gate) => gate,
        // The message never contains the value (see `validate_key`).
        Err(e) => return err_code(StatusCode::BAD_REQUEST, "access_key_weak", e.to_string()),
    };
    let digest = gate.digest_hex();
    if let Err(e) = state
        .config
        .lock_or_recover()
        .save_access_key_digest(Some(&digest))
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state
        .access_key
        .set(gate, crate::access_key::KeySource::Settings);
    crate::diagnostics::log_activity(
        &data_dir(&state),
        crate::diagnostics::ActivityEvent::new(
            "system",
            "accessKeySet",
            "chiave di accesso impostata dal pannello",
        ),
    );
    ok(access_key_status(&state)).into_response()
}

/// Remove the access key set from the panel (machine operation): the hub is
/// open again to anyone who reaches it.
async fn clear_access_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.access_key.locked_by_env() {
        return err_code(
            StatusCode::CONFLICT,
            "access_key_from_env",
            "the access key is set by REKORD_ACCESS_KEY; unset it there",
        );
    }
    if let Err(e) = state.config.lock_or_recover().save_access_key_digest(None) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.access_key.clear();
    crate::diagnostics::log_activity(
        &data_dir(&state),
        crate::diagnostics::ActivityEvent::new(
            "system",
            "accessKeyCleared",
            "chiave di accesso rimossa dal pannello",
        ),
    );
    ok(access_key_status(&state)).into_response()
}

async fn get_public_ip() -> impl IntoResponse {
    match crate::remote_access::resolve_public_ip().await {
        Some(ip) => ok(json!({ "ip": ip })).into_response(),
        None => ok(json!({ "ip": serde_json::Value::Null })).into_response(),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LegacyImportQuery {
    /// Compute the report only.
    dry_run: bool,
    /// Merge again accounts already imported from the same legacy files.
    force: bool,
}

/// `GET /api/v1/legacy-import`: is there legacy data, was it imported, and
/// the report of the last import.
async fn get_legacy_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let (data_dir, root) = {
        let cfg = state.config.lock_or_recover();
        (cfg.data_dir.clone(), cfg.music_root.clone())
    };
    let status = tokio::task::spawn_blocking(move || {
        backup::legacy_import_status(&data_dir, root.as_deref())
    })
    .await;
    match status {
        Ok(s) => ok(s).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/v1/legacy-import` (and the older `/library/sync-legacy-meta`):
/// merge `music_root/.kord` (library metadata and every account's personal
/// data) into the hub. `?dryRun=true` previews, `?force=true` re-merges
/// accounts imported before. Returns the `LegacyImportReport`.
async fn sync_legacy_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<LegacyImportQuery>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let (data_dir, root) = {
        let cfg = state.config.lock_or_recover();
        (cfg.data_dir.clone(), cfg.music_root.clone())
    };
    let Some(root) = root else {
        return err(StatusCode::BAD_REQUEST, "music_root not set");
    };
    if !root.join(".kord").is_dir() {
        return err(StatusCode::NOT_FOUND, "legacy_data_not_found");
    }
    // Under the scan lock: a scan rewrites the catalog the import links to.
    let Some(lease) = state.try_scan_lease() else {
        return err(StatusCode::CONFLICT, crate::state::SCAN_BUSY);
    };
    let db = state.db.clone();
    let job = (!q.dry_run).then(|| {
        state.jobs.start_coded(
            "legacy-sync",
            "Import dalla versione precedente",
            "legacySync.title",
            serde_json::Value::Null,
            false,
        )
    });
    let opts = backup::LegacyImportOptions {
        trigger: backup::LegacyImportTrigger::Manual,
        dry_run: q.dry_run,
        force: q.force,
        ..Default::default()
    };
    let out = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let out = backup::run_legacy_import(&db, &data_dir, &root, opts);
        if let Some(job) = job {
            match &out {
                Ok(report) => {
                    let t = &report.totals;
                    job.finish_coded(
                        "legacySync.done",
                        json!({
                            "accounts": report.imported_accounts(),
                            "favorites": t.favorites,
                            "playlists": t.playlists,
                            "moods": t.moods,
                            "blocked": t.excluded_tracks + t.excluded_albums,
                        }),
                        format!(
                            "{} account, {} preferiti, {} playlist, {} mood",
                            report.imported_accounts(),
                            t.favorites,
                            t.playlists,
                            t.moods
                        ),
                    )
                }
                Err(e) => job.fail(e.to_string()),
            }
        }
        out
    })
    .await;
    match out {
        Ok(Ok(report)) => ok(report).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_favorites(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.list_favorites(&account_id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct TrackIdBody {
    track_id: i64,
}

async fn add_favorite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<TrackIdBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.add_favorite(&account_id, body.track_id) {
        Ok(()) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "favorites",
                    "added",
                    format!("favorite added: {}", body.track_id),
                )
                .params(json!({ "trackId": body.track_id }))
                .account(Some(&account_id)),
            );
            ok(json!({ "track_id": body.track_id })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn remove_favorite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.remove_favorite(&account_id, id) {
        Ok(()) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "favorites",
                    "removed",
                    format!("favorite removed: {id}"),
                )
                .params(json!({ "trackId": id }))
                .account(Some(&account_id)),
            );
            ok(json!({ "track_id": id })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_playlists(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.list_playlists(&account_id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn create_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let name = body.name.trim();
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "name required");
    }
    match state.db.create_playlist(&account_id, name) {
        Ok(p) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "playlist",
                    "created",
                    format!("playlist created: {name}"),
                )
                .params(json!({ "name": name }))
                .account(Some(&account_id)),
            );
            ok(p).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.playlist_library_tracks(&account_id, &id) {
        Ok(tracks) => {
            if tracks.is_empty() {
                // Distinguish empty playlist vs missing: ownership check via list.
                let owned = state
                    .db
                    .list_playlists(&account_id)
                    .map(|pls| pls.iter().any(|p| p.id == id))
                    .unwrap_or(false);
                if !owned {
                    return err(StatusCode::NOT_FOUND, "playlist not found");
                }
            }
            ok(json!({ "id": id, "tracks": tracks })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn rename_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.rename_playlist(&account_id, &id, body.name.trim()) {
        Ok(true) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "playlist",
                    "renamed",
                    format!("playlist renamed: {} → {}", id, body.name.trim()),
                )
                .params(json!({ "id": id, "name": body.name.trim() }))
                .account(Some(&account_id)),
            );
            ok(json!({ "id": id, "name": body.name })).into_response()
        }
        Ok(false) => err(StatusCode::NOT_FOUND, "playlist not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.delete_playlist(&account_id, &id) {
        Ok(true) => {
            crate::diagnostics::log_activity(
                &data_dir(&state),
                crate::diagnostics::ActivityEvent::new(
                    "playlist",
                    "deleted",
                    format!("playlist deleted: {id}"),
                )
                .params(json!({ "id": id }))
                .account(Some(&account_id)),
            );
            ok(json!({ "id": id })).into_response()
        }
        Ok(false) => err(StatusCode::NOT_FOUND, "playlist not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn add_playlist_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<TrackIdBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.add_to_playlist(&account_id, &id, body.track_id) {
        Ok(()) => ok(json!({ "playlist_id": id, "track_id": body.track_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, msg)
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderTracksBody {
    track_ids: Vec<i64>,
}

async fn reorder_playlist_tracks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<ReorderTracksBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.reorder_playlist(&account_id, &id, &body.track_ids) {
        Ok(()) => ok(json!({ "id": id, "trackIds": body.track_ids })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, msg)
            } else if msg.contains("does not match") || msg.contains("duplicate") {
                err(StatusCode::CONFLICT, msg)
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        }
    }
}

#[derive(Deserialize)]
struct RemoveTrackQuery {
    track_id: i64,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn remove_playlist_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<RemoveTrackQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(
        &state,
        &headers,
        &AccountQuery {
            account_id: q.account_id.clone(),
        }
    );
    match state.db.remove_from_playlist(&account_id, &id, q.track_id) {
        Ok(()) => ok(json!({ "playlist_id": id, "track_id": q.track_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, msg)
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        }
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

#[derive(Deserialize)]
struct EntityInfoQuery {
    artist: String,
    album: Option<String>,
}

async fn get_entity_info(
    State(state): State<AppState>,
    Query(q): Query<EntityInfoQuery>,
) -> impl IntoResponse {
    let root = {
        let cfg = state.config.lock_or_recover();
        cfg.music_root.clone()
    };
    let Some(root) = root else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "music root not configured");
    };
    let album = q.album.as_deref().filter(|s| !s.trim().is_empty());
    match entity_info::get_entity_info(&root, &q.artist, album) {
        Ok(bundle) => ok(bundle).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else if msg.contains("invalid") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            err(status, msg)
        }
    }
}

/// The archive carries settings, accounts and credentials (cookies), so it is
/// a machine operation (legacy: server admin only).
async fn download_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(aq): Query<AccountQuery>,
) -> Response {
    if let Err(r) =
        crate::perm::require_machine_op(&state, &headers, aq.account_id.as_deref(), peer)
    {
        return r;
    }
    match tokio::task::spawn_blocking({
        let state = state.clone();
        move || backup::build_backup_zip(&state)
    })
    .await
    {
        Ok(Ok((bytes, filename))) => {
            let mut res = bytes.into_response();
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            );
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            if let Ok(cd) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                filename.replace('"', "")
            )) {
                res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
            }
            res
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn download_theme_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> Response {
    let account_id = match resolve_account(&state, &headers, &aq) {
        Ok(id) => id,
        Err(r) => return r,
    };
    match tokio::task::spawn_blocking({
        let state = state.clone();
        move || backup::build_theme_export_zip(&state, &account_id)
    })
    .await
    {
        Ok(Ok((bytes, filename))) => {
            let mut res = bytes.into_response();
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            );
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            if let Ok(cd) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                filename.replace('"', "")
            )) {
                res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
            }
            res
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize, Default)]
struct RestoreQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    /// When true, only accept a theme package (reject full backups).
    #[serde(default, rename = "themeOnly")]
    theme_only: bool,
}

/// Non-admin callers may only import a theme package (legacy 32 MiB policy).
const THEME_UPLOAD_MAX_BYTES: usize = 32 * 1024 * 1024;
const RESTORE_UPLOAD_MAX_BYTES: usize = 512 * 1024 * 1024;

/// True when the zip contains `rekord-theme.json` (any folder), i.e. a theme
/// package rather than a full backup. Reads only the central directory.
fn zip_is_theme_package(bytes: &[u8]) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return false;
    };
    (0..archive.len()).any(|i| {
        archive.by_index_raw(i).is_ok_and(|f| {
            !f.is_dir()
                && std::path::Path::new(f.name())
                    .file_name()
                    .and_then(|n| n.to_str())
                    == Some("rekord-theme.json")
        })
    })
}

async fn upload_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(rq): Query<RestoreQuery>,
    mut multipart: Multipart,
) -> Response {
    let aq = AccountQuery {
        account_id: rq.account_id.clone(),
    };
    let account_id = match resolve_account(&state, &headers, &aq) {
        Ok(id) => id,
        Err(r) => return r,
    };
    // Size policy is decided before reading: full restores need host rights.
    let machine_op =
        crate::perm::require_machine_op(&state, &headers, rq.account_id.as_deref(), peer);
    let max_bytes = if machine_op.is_ok() && !rq.theme_only {
        RESTORE_UPLOAD_MAX_BYTES
    } else {
        THEME_UPLOAD_MAX_BYTES
    };

    // Stream the file field into one buffer (no intermediate copies).
    let mut file_bytes: Option<Vec<u8>> = None;
    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name != "file" && !name.is_empty() {
            continue;
        }
        let mut buf = Vec::new();
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    if buf.len() + chunk.len() > max_bytes {
                        return err(StatusCode::PAYLOAD_TOO_LARGE, "Archive is too large");
                    }
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
        }
        file_bytes = Some(buf);
        break;
    }
    let Some(bytes) = file_bytes else {
        return err(StatusCode::BAD_REQUEST, "missing multipart file field");
    };
    if bytes.len() < 4 || &bytes[..2] != b"PK" {
        return err(StatusCode::BAD_REQUEST, "file is not a zip archive");
    }

    // Theme package? Apply only theme settings to the current account (legacy parity).
    if zip_is_theme_package(&bytes) {
        let st = state.clone();
        let imported = tokio::task::spawn_blocking(move || {
            backup::try_import_theme_zip(&st, &account_id, bytes)
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!(e.to_string())));
        return match imported {
            Ok(Some(report)) => ok(report).into_response(),
            Ok(None) => err(
                StatusCode::BAD_REQUEST,
                "Not a RE-KORD theme archive (missing rekord-theme.json)",
            ),
            Err(e) => {
                let msg = e.to_string();
                let status = if msg.contains("too large") {
                    StatusCode::PAYLOAD_TOO_LARGE
                } else if msg.contains("Invalid theme") || msg.contains("Unsupported image") {
                    StatusCode::BAD_REQUEST
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                };
                err(status, msg)
            }
        };
    }
    if rq.theme_only {
        return err(
            StatusCode::BAD_REQUEST,
            "Not a RE-KORD theme archive (missing rekord-theme.json)",
        );
    }

    // Theme packages are personal (handled above); a full restore rewrites the
    // machine's library and accounts, so it is a machine operation.
    if let Err(r) = machine_op {
        return r;
    }
    let job = state.jobs.start_coded(
        "restore",
        "Restore backup",
        "restore.title",
        serde_json::Value::Null,
        false,
    );
    // Restore unzips and rewrites the DB/library: keep it off the async workers.
    let handle = tokio::runtime::Handle::current();
    let st = state.clone();
    let restored = tokio::task::spawn_blocking(move || {
        handle.block_on(backup::restore_backup_zip(&st, bytes))
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!(e.to_string())));
    match restored {
        Ok(report) => {
            job.finish_coded(
                "restore.done",
                json!({
                    "tracks": report.scanned_tracks,
                    "favorites": report.favorites,
                    "playlists": report.playlists,
                }),
                format!(
                    "{} tracce, {} preferiti, {} playlist",
                    report.scanned_tracks, report.favorites, report.playlists
                ),
            );
            ok(report).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            job.fail(msg.clone());
            let status = if msg.contains("unsupported")
                || msg.contains("missing")
                || msg.contains("not a directory")
                || msg.contains("no music_root")
            {
                StatusCode::BAD_REQUEST
            } else if msg.contains("scan already") || msg.contains("could not start scan") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            err(status, msg)
        }
    }
}

async fn get_my_library_selection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match load_selection(&state, &account_id) {
        Ok(sel) => ok(sel).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn patch_my_library_selection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
    Json(patch): Json<SelectionPatch>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let dir = data_dir(&state);
    let cur = match selection::read_library_selection(&dir, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let (artists, albums) = match (state.db.list_artists(), state.db.list_albums()) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    let keys = CatalogKeys::from_albums_and_artists(&artists, &albums);
    let merged = selection::merge_selection_patch(&cur, &patch, &keys);
    match selection::write_library_selection(&dir, &account_id, &merged) {
        Ok(saved) => {
            crate::diagnostics::log_activity(
                &dir,
                crate::diagnostics::ActivityEvent::new(
                    "library",
                    "selection",
                    "library selection updated",
                )
                .account(Some(&account_id)),
            );
            ok(saved).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_accounts(State(state): State<AppState>) -> impl IntoResponse {
    match accounts::get_accounts_snapshot(&data_dir(&state)) {
        Ok(snap) => ok(snap).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Registry changes need host access (legacy: server admin, any account).
macro_rules! host_op_or_err {
    ($state:expr, $headers:expr, $peer:expr) => {
        if let Err(response) = crate::perm::require_host_op($state, $headers, $peer) {
            return response;
        }
    };
}

async fn create_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<NameBody>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    let dir = data_dir(&state);
    match accounts::create_account(&dir, body.name.trim()) {
        Ok(snap) => {
            let aid = snap.created_account_id.as_deref().unwrap_or_default();
            crate::diagnostics::log_activity(
                &dir,
                crate::diagnostics::ActivityEvent::new(
                    "account",
                    "created",
                    format!("account created: {}", body.name.trim()),
                )
                .params(json!({ "name": body.name.trim() }))
                .account(if aid.is_empty() { None } else { Some(aid) }),
            );
            (StatusCode::CREATED, ok(snap)).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "account create failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "account_create_failed")
        }
    }
}

async fn update_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    if !accounts::is_valid_account_id(id.trim()) {
        return err(StatusCode::BAD_REQUEST, "invalid_account_id");
    }
    let dir = data_dir(&state);
    match accounts::update_account(&dir, &id, Some(body.name.trim())) {
        Ok(snap) => {
            crate::diagnostics::log_activity(
                &dir,
                crate::diagnostics::ActivityEvent::new(
                    "account",
                    "renamed",
                    format!("account renamed: {}", body.name.trim()),
                )
                .params(json!({ "name": body.name.trim() }))
                .account(Some(&id)),
            );
            ok(snap).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, "account_not_found")
            } else {
                tracing::warn!(error = %e, "account update failed");
                err(StatusCode::BAD_REQUEST, "account_update_failed")
            }
        }
    }
}

async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<String>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    if !accounts::is_valid_account_id(id.trim()) {
        return err(StatusCode::BAD_REQUEST, "invalid_account_id");
    }
    let dir = data_dir(&state);
    match accounts::delete_account(&dir, &id) {
        Ok(snap) => {
            if let Err(e) = state.db.delete_account_user_data(&id) {
                tracing::warn!(account = %id, error = %e, "account rows not deleted");
            }
            crate::diagnostics::log_activity(
                &dir,
                crate::diagnostics::ActivityEvent::new(
                    "account",
                    "deleted",
                    format!("account deleted: {id}"),
                )
                .params(json!({ "id": id }))
                .account(Some(&id)),
            );
            ok(snap).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, "account_not_found")
            } else if msg.contains("default") {
                err(StatusCode::FORBIDDEN, "cannot_delete_default_account")
            } else if msg.contains("at least one") {
                err(StatusCode::FORBIDDEN, "last_account")
            } else {
                tracing::warn!(error = %e, "account delete failed");
                err(StatusCode::BAD_REQUEST, "account_delete_failed")
            }
        }
    }
}

/// A profile holds personal data: callers may export their own account; any
/// other account needs a machine operation.
async fn export_account_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(aq): Query<AccountQuery>,
    Path(id): Path<String>,
) -> Response {
    if !accounts::is_valid_account_id(id.trim()) {
        return err(StatusCode::BAD_REQUEST, "invalid_account_id");
    }
    let caller = match resolve_account(&state, &headers, &aq) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if caller != id {
        if let Err(r) =
            crate::perm::require_machine_op(&state, &headers, aq.account_id.as_deref(), peer)
        {
            return r;
        }
    }
    let dir = data_dir(&state);
    let snap = match accounts::get_accounts_snapshot(&dir) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(account) = snap.accounts.iter().find(|a| a.id == id) else {
        return err(StatusCode::NOT_FOUND, "account_not_found");
    };
    let selection = match selection::read_library_selection(&dir, &id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let favorites = match state.db.export_favorite_rel_paths(&id) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let playlists = match state.db.export_playlists_backup(&id) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let manifest = json!({
        "kordProfile": 1,
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "account": { "id": account.id, "name": account.name },
    });

    let built = (|| -> Result<(Vec<u8>, String), anyhow::Error> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file("profile.json", opts)?;
            zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
            zip.start_file("library-selection.json", opts)?;
            zip.write_all(serde_json::to_string_pretty(&selection)?.as_bytes())?;
            zip.start_file("favorites.json", opts)?;
            zip.write_all(serde_json::to_string_pretty(&favorites)?.as_bytes())?;
            zip.start_file("playlists.json", opts)?;
            zip.write_all(serde_json::to_string_pretty(&playlists)?.as_bytes())?;
            zip.finish()?;
        }
        let bytes = cursor.into_inner();
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ");
        let safe_name: String = account
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let filename = format!("rekord-profile-{safe_name}-{stamp}.zip");
        Ok((bytes, filename))
    })();

    match built {
        Ok((bytes, filename)) => {
            let mut res = bytes.into_response();
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            );
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            if let Ok(cd) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                filename.replace('"', "")
            )) {
                res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
            }
            res
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct CatalogQuery {
    summary: Option<String>,
    #[serde(rename = "artistId")]
    artist_id: Option<String>,
}

async fn get_catalog(
    State(state): State<AppState>,
    Query(q): Query<CatalogQuery>,
) -> impl IntoResponse {
    let summary = q.summary.as_deref() == Some("1");
    let artist_id = q
        .artist_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match state.db.build_catalog(summary, artist_id) {
        Ok(cat) => ok(cat).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
