use crate::accounts;
use crate::backup;
use crate::entity_info;
use crate::selection::{
    self, CatalogKeys, LibrarySelection, SelectionFilterMode, SelectionPatch,
};
use crate::state::AppState;
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
        .route("/api/v1/library/albums", get(list_albums))
        .route("/api/v1/library/albums/{id}", get(get_album))
        .route("/api/v1/library/albums/{id}/tracks", get(album_tracks))
        .route("/api/v1/library/artists", get(list_artists))
        .route("/api/v1/library/artists/{id}", get(get_artist))
        .route("/api/v1/library/artists/{id}/albums", get(artist_albums))
        .route("/api/v1/library/tracks/{id}", get(get_track))
        .route("/api/v1/library/path", get(get_music_path).put(set_music_path))
        .route("/api/v1/library/scan", post(run_scan))
        .route("/api/v1/favorites", get(list_favorites).post(add_favorite))
        .route("/api/v1/favorites/{id}", delete(remove_favorite))
        .route("/api/v1/playlists", get(list_playlists).post(create_playlist))
        .route(
            "/api/v1/playlists/{id}",
            get(get_playlist)
                .put(rename_playlist)
                .delete(delete_playlist),
        )
        .route(
            "/api/v1/playlists/{id}/tracks",
            post(add_playlist_track).delete(remove_playlist_track),
        )
        .route("/api/v1/modules", get(list_modules))
        .route("/api/v1/entity-info", get(get_entity_info))
        .route("/api/entity-info", get(get_entity_info))
        .route("/api/v1/backup/kord-data", get(download_backup))
        .route("/api/backup/kord-data", get(download_backup))
        .route("/api/backup/rekord-data", get(download_backup))
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
        .route(
            "/api/v1/accounts/{id}/export",
            get(export_account_profile),
        )
        .route(
            "/api/accounts/{id}/export",
            get(export_account_profile),
        )
}

fn data_dir(state: &AppState) -> PathBuf {
    state.config.lock().unwrap().data_dir.clone()
}

#[derive(Debug, Deserialize, Default)]
struct AccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

fn resolve_account(state: &AppState, headers: &HeaderMap, q: &AccountQuery) -> Result<String, String> {
    let dir = data_dir(state);
    let requested = accounts::account_id_from_headers_and_query(headers, q.account_id.as_deref());
    accounts::resolve_account_id(&dir, requested.as_deref()).map_err(|e| e.to_string())
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

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "RE-KORD",
        "version": env!("CARGO_PKG_VERSION"),
        "modules": state.modules.enabled_ids(),
        "scanning": state.is_scanning(),
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
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let sel = match load_selection(&state, &account_id) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::Empty {
        return ok(Vec::<crate::db::Track>::new()).into_response();
    }
    match state.db.list_tracks(limit, offset) {
        Ok(tracks) => {
            if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::All {
                return ok(tracks).into_response();
            }
            match state.db.list_albums() {
                Ok(albums) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    ok(tracks).into_response()
                }
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn library_stats(State(state): State<AppState>) -> impl IntoResponse {
    let music_root_path = state.config.lock().unwrap().music_root.clone();
    let music_root = music_root_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    match state.db.stats(music_root) {
        Ok(mut stats) => {
            stats.scanning = state.is_scanning();
            if let Some(root) = music_root_path.as_ref() {
                if let Some(space) = crate::disk_space::volume_space(root) {
                    stats.disk_total_bytes = Some(space.total_bytes);
                    stats.disk_available_bytes = Some(space.available_bytes);
                }
            }
            ok(stats).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<i64>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

macro_rules! account_or_err {
    ($state:expr, $headers:expr, $q:expr) => {
        match resolve_account($state, $headers, $q) {
            Ok(id) => id,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
        }
    };
}

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
    if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::Empty {
        return ok(Vec::<crate::db::Track>::new()).into_response();
    }
    match state.db.search_tracks(&q.q, limit) {
        Ok(tracks) => {
            if selection::get_selection_filter_mode(&sel) == SelectionFilterMode::All {
                return ok(tracks).into_response();
            }
            match state.db.list_albums() {
                Ok(albums) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    ok(tracks).into_response()
                }
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
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
    match state.db.album_tracks(id) {
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
            match (
                state.db.list_albums(),
                state.db.list_tracks(50_000, 0),
            ) {
                (Ok(albums), Ok(tracks)) => {
                    let albums = selection::filter_albums(albums, &sel);
                    let tracks = selection::filter_tracks(tracks, &albums, &sel);
                    let filtered =
                        selection::filter_artists(vec![a], &albums, &tracks, &sel);
                    match filtered.into_iter().next() {
                        Some(a) => ok(a).into_response(),
                        None => err(StatusCode::NOT_FOUND, "artist not found"),
                    }
                }
                (Err(e), _) | (_, Err(e)) => {
                    err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                }
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

async fn get_track(State(state): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    match state.db.get_track(id) {
        Ok(Some(t)) => ok(t).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "track not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_music_path(State(state): State<AppState>) -> impl IntoResponse {
    let root = state
        .config
        .lock()
        .unwrap()
        .music_root
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    ok(json!({ "music_root": root }))
}

#[derive(Deserialize)]
struct SetPathBody {
    music_root: String,
}

async fn set_music_path(
    State(state): State<AppState>,
    Json(body): Json<SetPathBody>,
) -> impl IntoResponse {
    let path = PathBuf::from(body.music_root.trim());
    if !path.is_dir() {
        return err(StatusCode::BAD_REQUEST, "music_root is not a directory");
    }
    match state.config.lock().unwrap().save_music_root(path.clone()) {
        Ok(()) => {
            // First-time path (or never indexed): index in background so admin
            // "save path" is enough — no separate scan click required.
            if state.needs_initial_scan() {
                state.spawn_initial_scan_if_needed();
            }
            ok(json!({ "music_root": path })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn run_scan(State(state): State<AppState>) -> impl IntoResponse {
    if state.is_scanning() {
        return err(StatusCode::CONFLICT, "scan already in progress");
    }
    match state.run_scan_blocking().await {
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
        Ok(()) => ok(json!({ "track_id": body.track_id })).into_response(),
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
        Ok(()) => ok(json!({ "track_id": id })).into_response(),
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
        Ok(p) => ok(p).into_response(),
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
    match state.db.playlist_tracks(&account_id, &id) {
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
        Ok(true) => ok(json!({ "id": id, "name": body.name })).into_response(),
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
        Ok(true) => ok(json!({ "id": id })).into_response(),
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
    ok(state.modules.as_ref().clone())
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
        let cfg = state.config.lock().unwrap();
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

async fn download_backup(State(state): State<AppState>) -> Response {
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

async fn upload_restore(State(state): State<AppState>, mut multipart: Multipart) -> Response {
    let mut file_bytes: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" || name.is_empty() {
            match field.bytes().await {
                Ok(b) => {
                    if b.len() > 512 * 1024 * 1024 {
                        return err(StatusCode::PAYLOAD_TOO_LARGE, "backup zip too large (>512MiB)");
                    }
                    file_bytes = Some(b.to_vec());
                    break;
                }
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
        }
    }
    let Some(bytes) = file_bytes else {
        return err(StatusCode::BAD_REQUEST, "missing multipart file field");
    };
    if bytes.len() < 4 || &bytes[..2] != b"PK" {
        return err(StatusCode::BAD_REQUEST, "file is not a zip archive");
    }
    match backup::restore_backup_zip(&state, bytes).await {
        Ok(report) => ok(report).into_response(),
        Err(e) => {
            let msg = e.to_string();
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
        Ok(saved) => ok(saved).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_accounts(State(state): State<AppState>) -> impl IntoResponse {
    match accounts::get_accounts_snapshot(&data_dir(&state)) {
        Ok(snap) => ok(snap).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn create_account(
    State(state): State<AppState>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    match accounts::create_account(&data_dir(&state), body.name.trim()) {
        Ok(snap) => (StatusCode::CREATED, ok(snap)).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn update_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    match accounts::update_account(&data_dir(&state), &id, Some(body.name.trim())) {
        Ok(snap) => ok(snap).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, msg)
            } else {
                err(StatusCode::BAD_REQUEST, msg)
            }
        }
    }
}

async fn delete_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let dir = data_dir(&state);
    match accounts::delete_account(&dir, &id) {
        Ok(snap) => {
            let _ = state.db.delete_account_user_data(&id);
            ok(snap).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not found") {
                err(StatusCode::NOT_FOUND, msg)
            } else if msg.contains("default") || msg.contains("at least one") {
                err(StatusCode::FORBIDDEN, msg)
            } else {
                err(StatusCode::BAD_REQUEST, msg)
            }
        }
    }
}

async fn export_account_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let dir = data_dir(&state);
    let snap = match accounts::get_accounts_snapshot(&dir) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(account) = snap.accounts.iter().find(|a| a.id == id) else {
        return err(StatusCode::NOT_FOUND, "account not found");
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
    let artist_id = q.artist_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match state.db.build_catalog(summary, artist_id) {
        Ok(cat) => ok(cat).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
