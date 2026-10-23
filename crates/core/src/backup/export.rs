//! Backup ZIP export (`kordBackup: 3`) and theme package export / import.

use super::*;
use crate::sync::LockRecover;

pub(super) fn collect_library_sidecars(music_root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    if !music_root.is_dir() {
        return out;
    }
    for entry in WalkDir::new(music_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let name = entry.file_name().to_string_lossy();
        if !LIBRARY_SIDECAR_NAMES.iter().any(|n| *n == name) {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let Ok(rel) = abs.strip_prefix(music_root) else {
            continue;
        };
        // Skip anything under .kord / .rekord / .wpp
        if rel.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some(".kord" | ".rekord" | ".wpp" | "node_modules" | ".git")
            )
        }) {
            continue;
        }
        let rel_posix = rel.to_string_lossy().replace('\\', "/");
        out.push((abs, format!("libraries/shared/{rel_posix}")));
    }
    out
}

pub(super) fn collect_kord_dir(music_root: &Path) -> Vec<(PathBuf, String)> {
    let kord = music_root.join(".kord");
    let mut out = Vec::new();
    if !kord.is_dir() {
        return out;
    }
    for entry in WalkDir::new(&kord)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') && name.ends_with(".tmp") {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let Ok(rel) = abs.strip_prefix(&kord) else {
            continue;
        };
        let rel_posix = rel.to_string_lossy().replace('\\', "/");
        out.push((abs, format!("kord-db/{rel_posix}")));
    }
    out
}

/// Build a next hub backup ZIP (bytes).
pub fn build_backup_zip(state: &AppState) -> Result<(Vec<u8>, String)> {
    let (music_root, settings_path, modules_path, data_dir) = {
        let cfg = state.config.lock_or_recover();
        (
            cfg.music_root.clone(),
            cfg.settings_path(),
            cfg.modules_manifest.clone(),
            cfg.data_dir.clone(),
        )
    };

    let accounts_snap = accounts::ensure_accounts(&data_dir)?;
    let library_root = music_root
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());

    let manifest = json!({
        "kordBackup": BACKUP_VERSION,
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "libraryRoot": library_root,
        "kind": "rekord-next-backup",
        "dataDir": data_dir.to_string_lossy(),
        "accounts": accounts_snap.iter().map(|a| json!({ "id": a.id, "name": a.name })).collect::<Vec<_>>(),
        "defaultAccountId": DEFAULT_ACCOUNT_ID,
    });

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        add_bytes(
            &mut zip,
            "config/manifest.json",
            serde_json::to_string_pretty(&manifest)?.as_bytes(),
        )?;

        if settings_path.is_file() {
            add_file_path(&mut zip, &settings_path, "config/settings.json")?;
        } else if let Some(root) = &music_root {
            let body = serde_json::to_string_pretty(&json!({ "music_root": root }))?;
            add_bytes(&mut zip, "config/settings.json", body.as_bytes())?;
        }

        if modules_path.is_file() {
            add_file_path(&mut zip, &modules_path, "config/modules.manifest.toml")?;
        }

        let registry = accounts::accounts_registry_path(&data_dir);
        if registry.is_file() {
            add_file_path(&mut zip, &registry, "config/accounts.json")?;
        }

        // Flat hub/* = default account (backward compatible with older restores).
        let default_fav = state.db.export_favorite_rel_paths(DEFAULT_ACCOUNT_ID)?;
        let default_pl = state.db.export_playlists_backup(DEFAULT_ACCOUNT_ID)?;
        add_bytes(
            &mut zip,
            "hub/favorites.json",
            serde_json::to_string_pretty(&default_fav)?.as_bytes(),
        )?;
        add_bytes(
            &mut zip,
            "hub/playlists.json",
            serde_json::to_string_pretty(&default_pl)?.as_bytes(),
        )?;

        for acc in &accounts_snap {
            let fav = state.db.export_favorite_rel_paths(&acc.id)?;
            let pls = state.db.export_playlists_backup(&acc.id)?;
            let sel = selection::read_library_selection(&data_dir, &acc.id)?;
            let ustate = user_state::load_user_state(&data_dir, &acc.id);
            add_bytes(
                &mut zip,
                &format!("hub/accounts/{}/favorites.json", acc.id),
                serde_json::to_string_pretty(&fav)?.as_bytes(),
            )?;
            add_bytes(
                &mut zip,
                &format!("hub/accounts/{}/playlists.json", acc.id),
                serde_json::to_string_pretty(&pls)?.as_bytes(),
            )?;
            add_bytes(
                &mut zip,
                &format!("hub/accounts/{}/library-selection.json", acc.id),
                serde_json::to_string_pretty(&sel)?.as_bytes(),
            )?;
            add_bytes(
                &mut zip,
                &format!("hub/accounts/{}/user-state.json", acc.id),
                serde_json::to_string_pretty(&ustate)?.as_bytes(),
            )?;
            if let Some(theme_bg) = user_state::find_theme_bg_path(&data_dir, &acc.id) {
                let file_name = theme_bg
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("theme-bg.jpg");
                if let Err(e) = add_file_path(
                    &mut zip,
                    &theme_bg,
                    &format!("hub/accounts/{}/{}", acc.id, file_name),
                ) {
                    warn!(error = %e, account = %acc.id, "skip theme-bg in backup");
                }
            }
        }

        // Cookies + activity (shared hub data).
        let cookies = {
            let cfg = state.config.lock_or_recover();
            cfg.youtube_cookies_path
                .clone()
                .unwrap_or_else(|| cfg.default_youtube_cookies_path())
        };
        if cookies.is_file() {
            let _ = add_file_path(&mut zip, &cookies, "config/youtube-cookies.txt");
        }
        let activity = data_dir.join("activity.jsonl");
        if activity.is_file() {
            let _ = add_file_path(&mut zip, &activity, "config/kord-activity.log.jsonl");
        }
        // Same treatment as the cookies: machine credentials travel with the
        // backup so a restore on a new machine keeps working (never env tokens).
        let discogs_token = {
            let cfg = state.config.lock_or_recover();
            (!cfg.discogs_token_from_env)
                .then(|| cfg.discogs_token.clone())
                .flatten()
        };
        if let Some(token) = discogs_token {
            add_bytes(&mut zip, "config/discogs-token", token.as_bytes())?;
        }
        let remote_state = data_dir.join("remote-access.json");
        if remote_state.is_file() {
            let _ = add_file_path(&mut zip, &remote_state, "config/remote-access.json");
        }

        if let Some(root) = &music_root {
            for (abs, zip_name) in collect_library_sidecars(root) {
                if let Err(e) = add_file_path(&mut zip, &abs, &zip_name) {
                    warn!(error = %e, file = %abs.display(), "skip sidecar in backup");
                }
            }
            for (abs, zip_name) in collect_kord_dir(root) {
                if let Err(e) = add_file_path(&mut zip, &abs, &zip_name) {
                    warn!(error = %e, file = %abs.display(), "skip .kord file in backup");
                }
            }
        }

        zip.finish()?;
    }

    let bytes = cursor.into_inner();
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ");
    let filename = format!("rekord-backup-{stamp}.zip");
    info!(bytes = bytes.len(), %filename, "backup zip built");
    Ok((bytes, filename))
}

/// Shareable theme package (legacy-compatible): `rekord-theme/rekord-theme.json` + optional background.
pub fn build_theme_export_zip(state: &AppState, account_id: &str) -> Result<(Vec<u8>, String)> {
    let data_dir = state.config.lock_or_recover().data_dir.clone();
    let ustate = user_state::load_user_state(&data_dir, account_id);
    let settings = &ustate.settings;

    let theme = settings
        .get("theme")
        .and_then(|v| v.as_str())
        .unwrap_or("obsidian")
        .to_string();
    let glass_surfaces = settings
        .get("glassSurfaces")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let glass_opacity = settings.get("glassOpacity").cloned();

    let mut payload = json!({
        "kind": "rekord-theme",
        "version": 1,
        "theme": theme,
        "glassSurfaces": glass_surfaces,
    });
    if let Some(op) = glass_opacity {
        payload["glassOpacity"] = op;
    }

    let mut bg_bytes: Option<(Vec<u8>, String)> = None;
    if theme == "custom" {
        if let Some(ct) = settings.get("customTheme").cloned() {
            let mut ct_obj = ct;
            if let Some(map) = ct_obj.as_object_mut() {
                map.remove("bgImage");
                map.remove("bgImageRev");
                let bg_mode = map
                    .get("bgMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("color");
                if bg_mode == "image" {
                    if let Some(theme_bg) = user_state::find_theme_bg_path(&data_dir, account_id) {
                        let ext = theme_bg
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("jpg");
                        let name = format!("background.{ext}");
                        match fs::read(&theme_bg) {
                            Ok(bytes) => {
                                payload["backgroundFile"] = json!(name);
                                bg_bytes = Some((bytes, name));
                            }
                            Err(e) => {
                                warn!(error = %e, "theme export: skip background file");
                                map.insert("bgMode".into(), json!("color"));
                            }
                        }
                    } else {
                        map.insert("bgMode".into(), json!("color"));
                    }
                }
            }
            payload["customTheme"] = ct_obj;
        }
    }

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        add_bytes(
            &mut zip,
            &format!("rekord-theme/{THEME_EXPORT_JSON}"),
            serde_json::to_string_pretty(&payload)?.as_bytes(),
        )?;
        if let Some((bytes, name)) = bg_bytes {
            add_bytes(&mut zip, &format!("rekord-theme/{name}"), &bytes)?;
        }
        zip.finish()?;
    }

    let theme_label: String = theme
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let theme_label = if theme_label.is_empty() {
        "theme".to_string()
    } else {
        theme_label
    };
    let stamp = chrono::Utc::now().format("%Y-%m-%d");
    let filename = format!("rekord-theme-{theme_label}-{stamp}.zip");
    Ok((cursor.into_inner(), filename))
}

pub(super) fn find_theme_json_entry(
    archive: &mut ZipArchive<impl Read + std::io::Seek>,
) -> Option<String> {
    for i in 0..archive.len() {
        let Ok(f) = archive.by_index(i) else {
            continue;
        };
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let base = Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if base == THEME_EXPORT_JSON {
            return Some(name);
        }
    }
    None
}

pub(super) fn mime_for_theme_bg_name(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// If the zip is a theme package, apply it to `account_id` and return `Some`.
/// If it is not a theme package, return `Ok(None)` so restore can continue.
pub fn try_import_theme_zip(
    state: &AppState,
    account_id: &str,
    zip_bytes: impl AsRef<[u8]>,
) -> Result<Option<ThemeImportReport>> {
    let cursor = Cursor::new(zip_bytes.as_ref());
    let mut archive = match ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(_) => return Ok(None),
    };
    let Some(json_name) = find_theme_json_entry(&mut archive) else {
        return Ok(None);
    };
    let raw = {
        let mut f = archive
            .by_name(&json_name)
            .with_context(|| format!("read {json_name}"))?;
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        s
    };
    let payload: serde_json::Value =
        serde_json::from_str(&raw).context("Invalid theme archive: bad rekord-theme.json")?;
    if payload.get("kind").and_then(|v| v.as_str()) != Some("rekord-theme") {
        bail!("Invalid theme archive: bad rekord-theme.json");
    }

    let data_dir = state.config.lock_or_recover().data_dir.clone();
    // Settings to write; applied in one locked read-modify-write at the end.
    let mut patch = serde_json::Map::new();

    if let Some(theme) = payload.get("theme").and_then(|v| v.as_str()) {
        if !theme.trim().is_empty() {
            patch.insert("theme".into(), json!(theme.trim()));
        }
    }
    if let Some(gs) = payload.get("glassSurfaces").and_then(|v| v.as_bool()) {
        patch.insert("glassSurfaces".into(), json!(gs));
    }
    if let Some(op) = payload.get("glassOpacity") {
        if op.as_f64().is_some() || op.as_u64().is_some() || op.as_i64().is_some() {
            patch.insert("glassOpacity".into(), op.clone());
        }
    }

    let mut custom_theme = payload.get("customTheme").cloned();
    if let Some(ct) = custom_theme.as_mut().and_then(|v| v.as_object_mut()) {
        ct.remove("bgImage");
        ct.remove("bgImageRev");
    }

    let bg_file = payload
        .get("backgroundFile")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            Path::new(s)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(s)
                .to_string()
        });

    let mut bg_applied = false;
    if let Some(ref bg_name) = bg_file {
        let bg_entry = (0..archive.len()).find_map(|i| {
            let f = archive.by_index(i).ok()?;
            if f.is_dir() {
                return None;
            }
            let name = f.name().to_string();
            let base = Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if base == bg_name {
                Some(name)
            } else {
                None
            }
        });
        if let Some(entry_name) = bg_entry {
            let mut f = archive.by_name(&entry_name)?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            let mime = mime_for_theme_bg_name(bg_name);
            let ext = user_state::save_theme_bg(&data_dir, account_id, &buf, mime, bg_name)?;
            let rev = chrono::Utc::now().timestamp_millis();
            let mut ct = custom_theme
                .take()
                .unwrap_or_else(|| json!({}))
                .as_object()
                .cloned()
                .unwrap_or_default();
            ct.insert("bgMode".into(), json!("image"));
            ct.insert("bgImage".into(), json!(ext));
            ct.insert("bgImageRev".into(), json!(rev));
            custom_theme = Some(Value::Object(ct));
            bg_applied = true;
        }
    }

    if let Some(mut ct) = custom_theme {
        if !bg_applied {
            if let Some(map) = ct.as_object_mut() {
                if map.get("bgMode").and_then(|v| v.as_str()) == Some("image") {
                    map.insert("bgMode".into(), json!("color"));
                }
            }
        }
        patch.insert("customTheme".into(), ct);
    }

    let ustate = match user_state::update_user_state(&data_dir, account_id, None, |s| {
        s.settings.extend(patch);
    })? {
        user_state::UpdateOutcome::Saved(s) | user_state::UpdateOutcome::Conflict(s) => s,
    };

    let theme_out = ustate
        .settings
        .get("theme")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let glass_surfaces = ustate
        .settings
        .get("glassSurfaces")
        .and_then(|v| v.as_bool());
    let glass_opacity = ustate
        .settings
        .get("glassOpacity")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)));
    Ok(Some(ThemeImportReport {
        theme_imported: true,
        theme: theme_out,
        glass_surfaces,
        glass_opacity,
    }))
}
