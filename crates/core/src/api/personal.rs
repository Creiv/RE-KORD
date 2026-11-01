//! Per-account personal data: favorites, playlists, the library selection.

use super::*;

pub(super) async fn list_favorites(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.list_favorites(&account_id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

#[derive(Deserialize)]
pub(super) struct TrackIdBody {
    track_id: i64,
}

pub(super) async fn add_favorite(
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn remove_favorite(
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn list_playlists(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    match state.db.list_playlists(&account_id) {
        Ok(v) => ok(v).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn create_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
    Json(body): Json<NameBody>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let name = body.name.trim();
    if name.is_empty() {
        return err_code(StatusCode::BAD_REQUEST, "name_required", "name required");
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
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn get_playlist(
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
                    return err_code(
                        StatusCode::NOT_FOUND,
                        "playlist_not_found",
                        "playlist not found",
                    );
                }
            }
            ok(json!({ "id": id, "tracks": tracks })).into_response()
        }
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn rename_playlist(
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
        Ok(false) => err_code(
            StatusCode::NOT_FOUND,
            "playlist_not_found",
            "playlist not found",
        ),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn delete_playlist(
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
        Ok(false) => err_code(
            StatusCode::NOT_FOUND,
            "playlist_not_found",
            "playlist not found",
        ),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn add_playlist_track(
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
                err_code(StatusCode::NOT_FOUND, "not_found", msg)
            } else {
                internal(msg)
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReorderTracksBody {
    track_ids: Vec<i64>,
}

pub(super) async fn reorder_playlist_tracks(
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
                err_code(StatusCode::NOT_FOUND, "not_found", msg)
            } else if msg.contains("does not match") || msg.contains("duplicate") {
                err_code(StatusCode::CONFLICT, "playlist_tracks_mismatch", msg)
            } else {
                internal(msg)
            }
        }
    }
}

#[derive(Deserialize)]
pub(super) struct RemoveTrackQuery {
    track_id: i64,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

pub(super) async fn remove_playlist_track(
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
                err_code(StatusCode::NOT_FOUND, "not_found", msg)
            } else {
                internal(msg)
            }
        }
    }
}

pub(super) async fn get_my_library_selection(
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

pub(super) async fn patch_my_library_selection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(aq): Query<AccountQuery>,
    Json(patch): Json<SelectionPatch>,
) -> impl IntoResponse {
    let account_id = account_or_err!(&state, &headers, &aq);
    let dir = data_dir(&state);
    let cur = match selection::read_library_selection(&dir, &account_id) {
        Ok(s) => s,
        Err(e) => return internal(e.to_string()),
    };
    let (artists, albums) = match (state.db.list_artists(), state.db.list_albums()) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => {
            return internal(e.to_string());
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
        Err(e) => internal(e.to_string()),
    }
}
