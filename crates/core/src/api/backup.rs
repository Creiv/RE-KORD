//! Backup ZIPs: download, theme export, restore (and theme import) upload.

use super::*;

/// The archive carries settings, accounts and credentials (cookies), so it is
/// a machine operation (legacy: server admin only).
pub(super) async fn download_backup(
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
        move || crate::backup::build_backup_zip(&state)
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

pub(super) async fn download_theme_export(
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
        move || crate::backup::build_theme_export_zip(&state, &account_id)
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
        Ok(Err(e)) => internal(e.to_string()),
        Err(e) => internal(e.to_string()),
    }
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct RestoreQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    /// When true, only accept a theme package (reject full backups).
    #[serde(default, rename = "themeOnly")]
    theme_only: bool,
}

/// Non-admin callers may only import a theme package (legacy 32 MiB policy).
pub(super) const THEME_UPLOAD_MAX_BYTES: usize = 32 * 1024 * 1024;

pub(super) const RESTORE_UPLOAD_MAX_BYTES: usize = 512 * 1024 * 1024;

/// True when the zip contains `rekord-theme.json` (any folder), i.e. a theme
/// package rather than a full backup. Reads only the central directory.
pub(super) fn zip_is_theme_package(bytes: &[u8]) -> bool {
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

pub(super) async fn upload_restore(
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
                        return err_code(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "file_too_large",
                            "Archive is too large",
                        );
                    }
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => {
                    return err_code(StatusCode::BAD_REQUEST, "invalid_request", e.to_string())
                }
            }
        }
        file_bytes = Some(buf);
        break;
    }
    let Some(bytes) = file_bytes else {
        return err_code(
            StatusCode::BAD_REQUEST,
            "file_required",
            "missing multipart file field",
        );
    };
    if bytes.len() < 4 || &bytes[..2] != b"PK" {
        return err_code(
            StatusCode::BAD_REQUEST,
            "not_a_zip",
            "file is not a zip archive",
        );
    }

    // Theme package? Apply only theme settings to the current account (legacy parity).
    if zip_is_theme_package(&bytes) {
        let st = state.clone();
        let imported = tokio::task::spawn_blocking(move || {
            crate::backup::try_import_theme_zip(&st, &account_id, bytes)
        })
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!(e.to_string())));
        return match imported {
            Ok(Some(report)) => ok(report).into_response(),
            Ok(None) => err_code(
                StatusCode::BAD_REQUEST,
                "not_a_theme_archive",
                "Not a RE-KORD theme archive (missing rekord-theme.json)",
            ),
            Err(e) => {
                let msg = e.to_string();
                let (status, code) = if msg.contains("too large") {
                    (StatusCode::PAYLOAD_TOO_LARGE, "file_too_large")
                } else if msg.contains("Invalid theme") || msg.contains("Unsupported image") {
                    (StatusCode::BAD_REQUEST, "invalid_theme")
                } else {
                    (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
                };
                err_code(status, code, msg)
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
        handle.block_on(crate::backup::restore_backup_zip(&st, bytes))
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
            let (status, code) = if msg.contains("unsupported")
                || msg.contains("missing")
                || msg.contains("not a directory")
                || msg.contains("no music_root")
            {
                (StatusCode::BAD_REQUEST, "restore_invalid")
            } else if msg.contains("scan already") || msg.contains("could not start scan") {
                (StatusCode::CONFLICT, "scan_in_progress")
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            };
            err_code(status, code, msg)
        }
    }
}
