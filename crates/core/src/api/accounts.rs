//! Account registry: list, create, rename, delete, export a profile.

use super::*;

pub(super) async fn list_accounts(State(state): State<AppState>) -> impl IntoResponse {
    match crate::accounts::get_accounts_snapshot(&data_dir(&state)) {
        Ok(snap) => ok(snap).into_response(),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn create_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<NameBody>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    let dir = data_dir(&state);
    match crate::accounts::create_account(&dir, body.name.trim()) {
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

pub(super) async fn update_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    if !crate::accounts::is_valid_account_id(id.trim()) {
        return err(StatusCode::BAD_REQUEST, "invalid_account_id");
    }
    let dir = data_dir(&state);
    match crate::accounts::update_account(&dir, &id, Some(body.name.trim())) {
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

pub(super) async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<String>,
) -> Response {
    host_op_or_err!(&state, &headers, peer);
    if !crate::accounts::is_valid_account_id(id.trim()) {
        return err(StatusCode::BAD_REQUEST, "invalid_account_id");
    }
    let dir = data_dir(&state);
    match crate::accounts::delete_account(&dir, &id) {
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
pub(super) async fn export_account_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(aq): Query<AccountQuery>,
    Path(id): Path<String>,
) -> Response {
    if !crate::accounts::is_valid_account_id(id.trim()) {
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
    let snap = match crate::accounts::get_accounts_snapshot(&dir) {
        Ok(s) => s,
        Err(e) => return internal(e.to_string()),
    };
    let Some(account) = snap.accounts.iter().find(|a| a.id == id) else {
        return err(StatusCode::NOT_FOUND, "account_not_found");
    };
    let selection = match selection::read_library_selection(&dir, &id) {
        Ok(s) => s,
        Err(e) => return internal(e.to_string()),
    };
    let favorites = match state.db.export_favorite_rel_paths(&id) {
        Ok(v) => v,
        Err(e) => return internal(e.to_string()),
    };
    let playlists = match state.db.export_playlists_backup(&id) {
        Ok(v) => v,
        Err(e) => return internal(e.to_string()),
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
        Err(e) => internal(e.to_string()),
    }
}
