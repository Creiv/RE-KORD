//! Studio HTTP routes: download, fs, youtube, metadata, artwork, config.

use crate::accounts::{self, DEFAULT_ACCOUNT_ID};
use crate::entity_info::{self, EntityInfoSaveRequest};
use crate::metadata::{self, AlbumMetaPatch, TrackMetaPatch};
use crate::metadata::providers::wikipedia_search;
use crate::path_util::safe_rel_path;
use crate::selection::{self, CatalogKeys, SelectionPatch};
use crate::state::AppState;
use crate::studio_fs;
use crate::youtube_music::{self, ReleaseEntry};
use crate::ytdlp::{self, is_allowed_ytdlp_url, is_uuid_download_id, normalize_http_url};
use axum::body::Body;
use axum::extract::{Multipart, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use bytes::Bytes;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
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
            post(upload_youtube_cookies).delete(clear_youtube_cookies),
        )
        .route(
            "/api/config/youtube-cookies",
            post(upload_youtube_cookies).delete(clear_youtube_cookies),
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
        // Download
        .route("/api/v1/download", post(start_download))
        .route("/api/download", post(start_download))
        .route("/api/v1/download-cancel", post(cancel_download))
        .route("/api/download-cancel", post(cancel_download))
        .route("/api/v1/download-flat-count", post(download_flat_count))
        .route("/api/download-flat-count", post(download_flat_count))
        .route("/api/v1/download-preset", get(download_preset))
        .route("/api/download-preset", get(download_preset))
        // YouTube
        .route("/api/v1/youtube-explore-search", post(youtube_explore))
        .route("/api/youtube-explore-search", post(youtube_explore))
        .route("/api/v1/youtube-releases-list", post(youtube_releases))
        .route("/api/youtube-releases-list", post(youtube_releases))
        .route("/api/v1/catalog-web-discover", get(catalog_web_discover))
        .route("/api/catalog-web-discover", get(catalog_web_discover))
        // Artwork
        .route("/api/v1/artwork/search", get(artwork_search))
        .route("/api/artwork/search", get(artwork_search))
        .route("/api/v1/artwork/apply", post(artwork_apply))
        .route("/api/artwork/apply", post(artwork_apply))
        .route("/api/v1/artwork/upload", post(artwork_upload))
        .route("/api/artwork/upload", post(artwork_upload))
        // Album / track info
        .route("/api/v1/album-info/fetch", post(album_info_fetch))
        .route("/api/album-info/fetch", post(album_info_fetch))
        .route("/api/v1/album-info/save", post(album_info_save))
        .route("/api/album-info/save", post(album_info_save))
        .route("/api/v1/track-info/fetch", post(track_info_fetch))
        .route("/api/track-info/fetch", post(track_info_fetch))
        .route("/api/v1/track-info/fetch-album", post(track_info_fetch_album))
        .route("/api/track-info/fetch-album", post(track_info_fetch_album))
        .route("/api/v1/track-info/save", post(track_info_save))
        .route("/api/track-info/save", post(track_info_save))
        .route("/api/v1/discogs/search-releases", post(discogs_search))
        .route("/api/discogs/search-releases", post(discogs_search))
        .route("/api/v1/discogs/apply-release", post(discogs_apply))
        .route("/api/discogs/apply-release", post(discogs_apply))
        // Entity info mutate
        .route("/api/v1/entity-info/search", post(entity_info_search))
        .route("/api/entity-info/search", post(entity_info_search))
        .route("/api/v1/entity-info/save", post(entity_info_save))
        .route("/api/entity-info/save", post(entity_info_save))
}

fn ok<T: serde::Serialize>(data: T) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "data": data, "error": null }))
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = json!({ "ok": false, "data": null, "error": msg.into() });
    (status, Json(body)).into_response()
}

fn music_root(state: &AppState) -> Result<std::path::PathBuf, Response> {
    state
        .config
        .lock()
        .unwrap()
        .music_root
        .clone()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "music_root not set"))
}

async fn get_config(State(state): State<AppState>) -> impl IntoResponse {
    let snap = state.config.lock().unwrap().config_snapshot();
    ok(snap)
}

async fn upload_youtube_cookies(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Response {
    let mut bytes: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            match field.bytes().await {
                Ok(b) => bytes = Some(b.to_vec()),
                Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
            }
        }
    }
    let Some(bytes) = bytes else {
        return err(StatusCode::BAD_REQUEST, "file required");
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return err(StatusCode::BAD_REQUEST, "file too large (max 2MB)");
    }
    match state
        .config
        .lock()
        .unwrap()
        .set_youtube_cookies_bytes(&bytes)
    {
        Ok(_) => {
            let snap = state.config.lock().unwrap().config_snapshot();
            ok(snap).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn clear_youtube_cookies(State(state): State<AppState>) -> Response {
    match state.config.lock().unwrap().clear_youtube_cookies() {
        Ok(()) => {
            let snap = state.config.lock().unwrap().config_snapshot();
            ok(snap).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct DiscogsTokenBody {
    token: String,
}

async fn set_discogs_token(
    State(state): State<AppState>,
    Json(body): Json<DiscogsTokenBody>,
) -> Response {
    match state.config.lock().unwrap().set_discogs_token(&body.token) {
        Ok(()) => {
            let snap = state.config.lock().unwrap().config_snapshot();
            ok(snap).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn clear_discogs_token(State(state): State<AppState>) -> Response {
    match state.config.lock().unwrap().clear_discogs_token() {
        Ok(()) => {
            let snap = state.config.lock().unwrap().config_snapshot();
            ok(snap).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
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
    match studio_fs::list_dirs(&root, q.path.as_deref().unwrap_or("")) {
        Ok(data) => {
            // Legacy raw shape + envelope
            ok(data).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
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
    match studio_fs::search_dirs(&root, q.q.as_deref().unwrap_or(""), 40) {
        Ok((results, truncated)) => ok(json!({ "results": results, "truncated": truncated })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MkdirBody {
    parent: Option<String>,
    name: String,
}

async fn fs_mkdir(State(state): State<AppState>, Json(body): Json<MkdirBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    match studio_fs::mkdir(&root, body.parent.as_deref().unwrap_or(""), &body.name) {
        Ok(rel) => ok(json!({ "ok": true, "relPath": rel })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBody {
    url: String,
    download_id: String,
    download_kind: Option<String>,
    output_dir: Option<String>,
}

async fn start_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<std::collections::HashMap<String, String>>,
    Json(body): Json<DownloadBody>,
) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "yt-dlp disabled (ENABLE_YTDLP=0)");
    }
    let url = normalize_http_url(&body.url);
    if !is_allowed_ytdlp_url(&url) {
        return err(StatusCode::BAD_REQUEST, "URL host not allowed");
    }
    if !is_uuid_download_id(&body.download_id) {
        return err(StatusCode::BAD_REQUEST, "downloadId must be UUID v4");
    }
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let kind = body
        .download_kind
        .unwrap_or_else(|| "download_unknown".into());
    let output_dir = match safe_rel_path(body.output_dir.as_deref().unwrap_or("")) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
    };

    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let requested = accounts::account_id_from_headers_and_query(
        &headers,
        aq.get("accountId").map(String::as_str),
    );
    let account_id = accounts::resolve_account_id(&data_dir, requested.as_deref())
        .unwrap_or_else(|_| DEFAULT_ACCOUNT_ID.to_string());

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.active_downloads.lock().unwrap();
        if map.contains_key(&body.download_id) {
            return err(StatusCode::CONFLICT, "downloadId already active");
        }
        map.insert(body.download_id.clone(), cancel.clone());
    }

    let (tx, rx) = mpsc::channel::<String>(32);
    let cfg = state.config.lock().unwrap().clone();
    let download_id = body.download_id.clone();
    let state2 = state.clone();
    let out_dir_for_post = output_dir.clone();

    tokio::spawn(async move {
        let _ = ytdlp::run_download_ndjson(
            cfg,
            root.clone(),
            url,
            kind,
            output_dir,
            cancel,
            tx,
        )
        .await;
        state2
            .active_downloads
            .lock()
            .unwrap()
            .remove(&download_id);

        // Post-download: rescan + attach selection for the requesting account
        if let Err(e) = state2.run_scan_blocking().await {
            tracing::warn!(error = %e, "post-download scan failed");
        } else if !out_dir_for_post.is_empty() {
            attach_download_to_selection(&state2, &account_id, &out_dir_for_post);
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
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
}

fn attach_download_to_selection(state: &AppState, account_id: &str, output_dir: &str) {
    let data_dir = state.config.lock().unwrap().data_dir.clone();
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
    let mut add_albums = Vec::new();
    let mut add_artists = Vec::new();
    for key in &keys_set {
        if key == prefix || key.starts_with(&format!("{prefix}/")) {
            add_albums.push(key.clone());
            if let Some(artist) = key.split('/').next() {
                add_artists.push(artist.to_string());
            }
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
        add_artists: Some(add_artists),
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

async fn cancel_download(State(state): State<AppState>, Json(body): Json<CancelBody>) -> Response {
    if let Some(flag) = state.active_downloads.lock().unwrap().get(&body.download_id) {
        flag.store(true, Ordering::SeqCst);
        return ok(json!({ "ok": true })).into_response();
    }
    ok(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct UrlBody {
    url: String,
}

async fn download_flat_count(State(state): State<AppState>, Json(body): Json<UrlBody>) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "yt-dlp disabled");
    }
    let url = normalize_http_url(&body.url);
    if !is_allowed_ytdlp_url(&url) {
        return err(StatusCode::BAD_REQUEST, "URL host not allowed");
    }
    let cfg = state.config.lock().unwrap().clone();
    match youtube_music::flat_playlist_count(&cfg, &url).await {
        Ok(count) => ok(json!({ "count": count })).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn download_preset(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.config.lock().unwrap();
    let program = ytdlp::resolve_ytdlp_path(&cfg);
    let cookies = cfg.youtube_cookies_for_ytdlp().is_some();
    ok(json!({
        "found": true,
        "file": null,
        "text": "RE-KORD Studio yt-dlp preset",
        "program": program.to_string_lossy(),
        "cookiesConfigured": cookies,
        "args": ["-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio"],
        "exampleUrl": null,
    }))
}

#[derive(Deserialize)]
struct ExploreBody {
    query: String,
}

async fn youtube_explore(Json(body): Json<ExploreBody>) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "yt-dlp disabled");
    }
    match youtube_music::explore_search(&body.query).await {
        Ok(results) => ok(json!({ "results": results })).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleasesBody {
    url: String,
    stream: Option<bool>,
    enrich_counts: Option<bool>,
}

async fn youtube_releases(State(state): State<AppState>, Json(body): Json<ReleasesBody>) -> Response {
    if !ytdlp::ytdlp_enabled() {
        return err(StatusCode::FORBIDDEN, "yt-dlp disabled");
    }
    let url = normalize_http_url(&body.url);
    if !youtube_music::is_youtube_releases_tab_url(&url)
        && !youtube_music::is_youtube_music_browse_url(&url)
    {
        return err(
            StatusCode::BAD_REQUEST,
            "URL must be a YouTube releases/browse/channel page",
        );
    }
    let cfg = state.config.lock().unwrap().clone();
    let enrich = body.enrich_counts.unwrap_or(false);
    let stream = body.stream.unwrap_or(false);

    if stream {
        let (tx, rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            match youtube_music::releases_list_via_ytdlp(&cfg, &url).await {
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
                                .send(json!({ "type": "entry_patch", "entry": patched }).to_string())
                                .await;
                        }
                    }
                    let _ = tx.send(r#"{"type":"done"}"#.into()).await;
                }
                Err(e) => {
                    let _ = tx
                        .send(json!({ "type": "error", "message": e.to_string() }).to_string())
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

    match youtube_music::releases_list_via_ytdlp(&cfg, &url).await {
        Ok(mut list) => {
            if enrich {
                for e in &mut list.entries {
                    e.track_count = youtube_music::enrich_track_count(&cfg, &e.url).await;
                }
            }
            ok(list).into_response()
        }
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn catalog_web_discover(State(state): State<AppState>) -> Response {
    let keys = state
        .db
        .all_album_folder_keys()
        .unwrap_or_default();
    let data = youtube_music::catalog_web_discover(&keys).await;
    ok(data).into_response()
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
    let cfg = state.config.lock().unwrap().clone();
    let query = q.q.or(q.term);
    match metadata::search_artwork(
        &cfg,
        query.as_deref(),
        q.artist.as_deref(),
        q.album.as_deref(),
    )
    .await
    {
        Ok(results) => ok(json!({ "results": results })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtworkApplyBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    image_url: String,
}

fn resolve_album_path(state: &AppState, album_path: Option<&str>, album_id: Option<i64>) -> Result<String, String> {
    if let Some(p) = album_path.map(str::trim).filter(|s| !s.is_empty()) {
        return safe_rel_path(p).map_err(|e| e.to_string());
    }
    if let Some(id) = album_id {
        return state
            .db
            .get_album(id)
            .map_err(|e| e.to_string())?
            .map(|a| a.folder_key)
            .ok_or_else(|| "album not found".into());
    }
    Err("albumPath or albumId required".into())
}

async fn artwork_apply(State(state): State<AppState>, Json(body): Json<ArtworkApplyBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    match metadata::apply_artwork_url(&root, &state.db, &path, &body.image_url).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn artwork_upload(State(state): State<AppState>, mut multipart: Multipart) -> Response {
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
                content_type = field
                    .content_type()
                    .unwrap_or("image/jpeg")
                    .to_string();
                file_bytes = field.bytes().await.ok().map(|b| b.to_vec());
            }
            _ => {}
        }
    }
    let Some(bytes) = file_bytes else {
        return err(StatusCode::BAD_REQUEST, "file required");
    };
    let path = match resolve_album_path(&state, album_path.as_deref(), album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    match metadata::upload_artwork(&root, &state.db, &path, &bytes, &content_type).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumFetchBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    artist: Option<String>,
    album: Option<String>,
}

async fn album_info_fetch(State(state): State<AppState>, Json(body): Json<AlbumFetchBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let cfg = state.config.lock().unwrap().clone();
    match metadata::album_info_fetch(
        &cfg,
        &root,
        &state.db,
        &path,
        body.artist.as_deref(),
        body.album.as_deref(),
    )
    .await
    {
        Ok(v) => Json(v).into_response(), // flat ok like legacy
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumSaveBody {
    album_path: Option<String>,
    album_id: Option<i64>,
    patch: AlbumMetaPatch,
}

async fn album_info_save(State(state): State<AppState>, Json(body): Json<AlbumSaveBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    match metadata::album_info_save(&root, &state.db, &path, body.patch).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackFetchBody {
    rel_path: Option<String>,
    track_id: Option<i64>,
}

async fn track_info_fetch(State(state): State<AppState>, Json(body): Json<TrackFetchBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = if let Some(p) = body.rel_path {
        p
    } else if let Some(id) = body.track_id {
        match state.db.get_track(id) {
            Ok(Some(t)) => t.rel_path,
            _ => return err(StatusCode::NOT_FOUND, "track not found"),
        }
    } else {
        return err(StatusCode::BAD_REQUEST, "relPath or trackId required");
    };
    let cfg = state.config.lock().unwrap().clone();
    match metadata::track_info_fetch(&cfg, &root, &state.db, &rel).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn track_info_fetch_album(
    State(state): State<AppState>,
    Json(body): Json<AlbumFetchBody>,
) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let cfg = state.config.lock().unwrap().clone();
    match metadata::track_info_fetch_album(&cfg, &root, &state.db, &path).await {
        Ok(v) => ok(v).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackSaveBody {
    rel_path: Option<String>,
    track_id: Option<i64>,
    patch: TrackMetaPatch,
}

async fn track_info_save(State(state): State<AppState>, Json(body): Json<TrackSaveBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let rel = if let Some(p) = body.rel_path {
        p
    } else if let Some(id) = body.track_id {
        match state.db.get_track(id) {
            Ok(Some(t)) => t.rel_path,
            _ => return err(StatusCode::NOT_FOUND, "track not found"),
        }
    } else {
        return err(StatusCode::BAD_REQUEST, "relPath or trackId required");
    };
    match metadata::track_info_save(&root, &state.db, &rel, body.patch).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct DiscogsSearchBody {
    artist: String,
    album: String,
}

async fn discogs_search(State(state): State<AppState>, Json(body): Json<DiscogsSearchBody>) -> Response {
    let cfg = state.config.lock().unwrap().clone();
    match metadata::discogs_search(&cfg, &body.artist, &body.album).await {
        Ok(candidates) => ok(json!({ "ok": true, "candidates": candidates })).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
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

async fn discogs_apply(State(state): State<AppState>, Json(body): Json<DiscogsApplyBody>) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let path = match resolve_album_path(&state, body.album_path.as_deref(), body.album_id) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let cfg = state.config.lock().unwrap().clone();
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
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitySearchBody {
    artist: String,
    album: Option<String>,
    lang: Option<String>,
}

async fn entity_info_search(Json(body): Json<EntitySearchBody>) -> Response {
    let lang = body.lang.as_deref().unwrap_or("it");
    match wikipedia_search(&body.artist, body.album.as_deref(), lang).await {
        Ok(candidates) => ok(json!({ "candidates": candidates })).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn entity_info_save(
    State(state): State<AppState>,
    Json(body): Json<EntityInfoSaveRequest>,
) -> Response {
    let root = match music_root(&state) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let image_url = body.image_url.clone();
    let artist = body.artist.clone();
    match entity_info::save_entity_info(&root, body) {
        Ok(mut bundle) => {
            if let Some(url) = image_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if let Ok(dir) = entity_info::resolve_artist_dir(&root, &artist) {
                    if let Ok(client) = reqwest::Client::builder()
                        .user_agent("RE-KORD/5.1")
                        .timeout(std::time::Duration::from_secs(20))
                        .build()
                    {
                        if let Ok(res) = client.get(url).send().await {
                            if let Ok(bytes) = res.bytes().await {
                                if let Ok(name) =
                                    entity_info::set_artist_image_bytes(&dir, &bytes)
                                {
                                    bundle.image = Some(name);
                                }
                            }
                        }
                    }
                }
            }
            ok(bundle).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}
