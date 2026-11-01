//! Library routes: listing, search, pages, deltas, covers' metadata, the music
//! folder, scans, layout, watcher, embedded tags, the legacy import, trivia.

use super::*;

#[derive(Deserialize)]
pub(super) struct ListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

pub(super) async fn library_index(
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
            Err(e) => internal(e.to_string()),
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
                (Err(e), _) | (_, Err(e)) => internal(e.to_string()),
            }
        }
    }
}

/// Paginated personal-library tracks. Total is the selection-filtered count, so
/// clients can page without holding the whole catalog in memory.
pub(super) async fn tracks_page(
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
                (Err(e), _) | (_, Err(e)) => internal(e.to_string()),
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
                (Err(e), _) | (_, Err(e)) => internal(e.to_string()),
            }
        }
    }
}

pub(super) async fn artists_page(
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
        (Err(e), _) | (_, Err(e)) => internal(e.to_string()),
    }
}

#[derive(Deserialize, Default)]
pub(super) struct ChangesQuery {
    /// RFC3339 cursor from a previous response (`revision`).
    since: Option<String>,
    limit: Option<i64>,
}

/// Delta since a revision cursor: updated tracks + removed rel paths.
pub(super) async fn library_changes(
    State(state): State<AppState>,
    Query(q): Query<ChangesQuery>,
) -> impl IntoResponse {
    let revision = match state.db.library_revision() {
        Ok(r) => r,
        Err(e) => return internal(e.to_string()),
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
        Err(e) => internal(e.to_string()),
    }
}

/// Library counters. With an account (query / header) the counts follow that
/// account's library selection, like every list endpoint; `catalog_track_count`
/// is always the whole indexed catalog.
pub(super) async fn library_stats(
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

/// Canonical genres of the account's library with track / album / artist
/// counts, most common first.
pub(super) async fn library_genres(
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

#[derive(Deserialize)]
pub(super) struct SearchQuery {
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
pub(super) async fn library_search(
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn list_albums(
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn album_tracks(
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
                    return err_code(StatusCode::NOT_FOUND, "album_not_found", "album not found");
                }
            }
            Ok(None) => {
                return err_code(StatusCode::NOT_FOUND, "album_not_found", "album not found")
            }
            Err(e) => return internal(e.to_string()),
        }
    }
    match state.db.library_album_tracks(id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn list_artists(
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
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => internal(e.to_string()),
    }
}

pub(super) async fn get_artist(
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
                        None => err_code(
                            StatusCode::NOT_FOUND,
                            "artist_not_found",
                            "artist not found",
                        ),
                    }
                }
                (Err(e), _) | (_, Err(e)) => internal(e.to_string()),
            }
        }
        Ok(None) => err_code(
            StatusCode::NOT_FOUND,
            "artist_not_found",
            "artist not found",
        ),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn artist_albums(
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_album(
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
                None => err_code(StatusCode::NOT_FOUND, "album_not_found", "album not found"),
            }
        }
        Ok(None) => err_code(StatusCode::NOT_FOUND, "album_not_found", "album not found"),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_track(
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
                        None => {
                            err_code(StatusCode::NOT_FOUND, "track_not_found", "track not found")
                        }
                    }
                }
                Err(e) => internal(e.to_string()),
            }
        }
        Ok(None) => err_code(StatusCode::NOT_FOUND, "track_not_found", "track not found"),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_music_path(State(state): State<AppState>) -> impl IntoResponse {
    let root = state
        .config
        .lock_or_recover()
        .music_root
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    ok(json!({ "music_root": root }))
}

#[derive(Deserialize)]
pub(super) struct SetPathBody {
    music_root: String,
}

pub(super) async fn set_music_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<SetPathBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let path = PathBuf::from(body.music_root.trim());
    if !path.is_dir() {
        return err_code(
            StatusCode::BAD_REQUEST,
            "music_root_not_directory",
            "music_root is not a directory",
        );
    }
    // Drop the config guard before needs_initial_scan (it locks again).
    if let Err(e) = state.config.lock_or_recover().save_music_root(path.clone()) {
        return internal(e.to_string());
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
pub(super) struct ScanQuery {
    /// `incremental` (default) or `full`.
    mode: Option<String>,
}

pub(super) async fn run_scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ScanQuery>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.is_scanning() {
        return err_code(
            StatusCode::CONFLICT,
            "scan_in_progress",
            "scan already in progress",
        );
    }
    let mode = crate::scan::ScanMode::from_query(q.mode.as_deref());
    match state.run_scan_mode(mode).await {
        Ok(report) => ok(report).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("music_root not set") {
                err_code(StatusCode::BAD_REQUEST, "music_root_not_set", msg)
            } else if msg.contains("already in progress") {
                err_code(StatusCode::CONFLICT, "scan_in_progress", msg)
            } else {
                internal(msg)
            }
        }
    }
}

#[derive(Deserialize, Default)]
pub(super) struct ProbeQuery {
    #[serde(rename = "sampleLimit")]
    sample_limit: Option<u64>,
}

/// Analyse the folder structure without touching the DB (setup helper). A
/// machine operation like the layout it feeds: it walks the music folder.
pub(super) async fn probe_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ProbeQuery>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return err_code(
            StatusCode::BAD_REQUEST,
            "music_root_not_set",
            "music_root not set",
        );
    };
    let limit = q.sample_limit.unwrap_or(200);
    match tokio::task::spawn_blocking(move || crate::layout::probe_structure(&root, limit)).await {
        Ok(report) => ok(report).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_library_layout(State(state): State<AppState>) -> impl IntoResponse {
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return ok(crate::layout::LibraryLayout::default()).into_response();
    };
    ok(crate::layout::load_layout(&root)).into_response()
}

pub(super) async fn set_library_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<crate::layout::LibraryLayout>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    let root = state.config.lock_or_recover().music_root.clone();
    let Some(root) = root else {
        return err_code(
            StatusCode::BAD_REQUEST,
            "music_root_not_set",
            "music_root not set",
        );
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_watch(State(state): State<AppState>) -> impl IntoResponse {
    let enabled = state.config.lock_or_recover().watch_library;
    ok(state.watcher.status(enabled))
}

pub(super) async fn set_watch(
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
        return internal(e.to_string());
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
pub(super) async fn run_thumbnail_backfill(
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

pub(super) async fn get_embedded(State(state): State<AppState>) -> Response {
    match crate::embedded::backfill::status(&state) {
        Ok(s) => ok(s).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EmbeddedBody {
    enabled: Option<bool>,
    priority: Option<String>,
    embed_downloads: Option<bool>,
}

/// "Leggi metadati e copertine incorporati" and its priority. A change
/// re-reads the library in the background (the backfill job).
pub(super) async fn set_embedded(
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
            return internal(e.to_string());
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
pub(super) struct RereadBody {
    /// With the embedded priority: tag values also replace typed values.
    #[serde(default)]
    override_studio: bool,
}

/// "Rileggi metadati incorporati": refresh every value that came from the
/// tags (and embedded covers) as a background job.
pub(super) async fn reread_embedded(
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
        return internal(e.to_string());
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct LegacyImportQuery {
    /// Compute the report only.
    dry_run: bool,
    /// Merge again accounts already imported from the same legacy files.
    force: bool,
}

/// `GET /api/v1/legacy-import`: is there legacy data, was it imported, and
/// the report of the last import.
pub(super) async fn get_legacy_import(
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
        crate::backup::legacy_import_status(&data_dir, root.as_deref())
    })
    .await;
    match status {
        Ok(s) => ok(s).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

/// `POST /api/v1/legacy-import` (and the older `/library/sync-legacy-meta`):
/// merge `music_root/.kord` (library metadata and every account's personal
/// data) into the hub. `?dryRun=true` previews, `?force=true` re-merges
/// accounts imported before. Returns the `LegacyImportReport`.
pub(super) async fn sync_legacy_meta(
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
        return err_code(
            StatusCode::BAD_REQUEST,
            "music_root_not_set",
            "music_root not set",
        );
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
    let opts = crate::backup::LegacyImportOptions {
        trigger: crate::backup::LegacyImportTrigger::Manual,
        dry_run: q.dry_run,
        force: q.force,
        ..Default::default()
    };
    let out = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let out = crate::backup::run_legacy_import(&db, &data_dir, &root, opts);
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

#[derive(Deserialize)]
pub(super) struct EntityInfoQuery {
    artist: String,
    album: Option<String>,
}

pub(super) async fn get_entity_info(
    State(state): State<AppState>,
    Query(q): Query<EntityInfoQuery>,
) -> impl IntoResponse {
    let root = {
        let cfg = state.config.lock_or_recover();
        cfg.music_root.clone()
    };
    let Some(root) = root else {
        return err_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "music_root_not_set",
            "music root not configured",
        );
    };
    let album = q.album.as_deref().filter(|s| !s.trim().is_empty());
    match entity_info::get_entity_info(&root, &q.artist, album) {
        Ok(bundle) => ok(bundle).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let (status, code) = if msg.contains("not found") {
                (StatusCode::NOT_FOUND, "entity_info_not_found")
            } else if msg.contains("invalid") {
                (StatusCode::BAD_REQUEST, "invalid_request")
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            };
            err_code(status, code, msg)
        }
    }
}

#[derive(Deserialize)]
pub(super) struct CatalogQuery {
    summary: Option<String>,
    #[serde(rename = "artistId")]
    artist_id: Option<String>,
}

pub(super) async fn get_catalog(
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
        Err(e) => internal(e.to_string()),
    }
}
