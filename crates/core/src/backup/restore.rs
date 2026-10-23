//! Restore of next v3 and legacy v2 backup ZIPs.

use super::*;
use crate::sync::LockRecover;

#[derive(Default)]
struct AccountRestoreBundle {
    favorites: Vec<String>,
    playlists: Vec<PlaylistBackup>,
    selection: Option<selection::LibrarySelection>,
    user_state: Option<UserStateV1>,
    theme_bg: Option<PathBuf>,
}

pub(super) fn account_name_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_ascii_lowercase()
}

/// Map backup account ids onto existing hub ids when the display name matches
/// (case-insensitive). Same-id always wins; `default` always stays `default`.
/// Returns `(registry with target ids + backup names, backup_id → target_id)`.
pub(super) fn resolve_restore_account_targets(
    backup_registry: &[Account],
    existing_hub: &[Account],
) -> (Vec<Account>, BTreeMap<String, String>) {
    let hub_ids: std::collections::HashSet<&str> =
        existing_hub.iter().map(|a| a.id.as_str()).collect();
    let mut id_map = BTreeMap::new();
    let mut used_targets = std::collections::HashSet::new();
    let mut final_reg = Vec::new();

    for bak in backup_registry {
        let mut target = if bak.id == DEFAULT_ACCOUNT_ID {
            DEFAULT_ACCOUNT_ID.to_string()
        } else if hub_ids.contains(bak.id.as_str()) {
            bak.id.clone()
        } else {
            let key = account_name_key(&bak.name);
            existing_hub
                .iter()
                .find(|h| {
                    h.id != DEFAULT_ACCOUNT_ID
                        && !used_targets.contains(h.id.as_str())
                        && !backup_registry.iter().any(|b| b.id == h.id)
                        && account_name_key(&h.name) == key
                })
                .map(|h| h.id.clone())
                .unwrap_or_else(|| bak.id.clone())
        };
        if used_targets.contains(target.as_str()) {
            target = bak.id.clone();
        }
        if used_targets.contains(target.as_str()) {
            // Extremely unlikely: bak.id already claimed — keep first mapping only.
            continue;
        }
        used_targets.insert(target.clone());
        id_map.insert(bak.id.clone(), target.clone());
        final_reg.push(Account {
            id: target,
            name: bak.name.clone(),
        });
    }

    (final_reg, id_map)
}

fn remap_account_bundles(
    per_account: BTreeMap<String, AccountRestoreBundle>,
    id_map: &BTreeMap<String, String>,
) -> BTreeMap<String, AccountRestoreBundle> {
    let mut remapped = BTreeMap::new();
    for (bak_id, bundle) in per_account {
        let target = id_map
            .get(&bak_id)
            .cloned()
            .unwrap_or_else(|| bak_id.clone());
        merge_account_bundle(&mut remapped, &target, bundle);
    }
    remapped
}

fn merge_account_bundle(
    map: &mut BTreeMap<String, AccountRestoreBundle>,
    acc_id: &str,
    mut patch: AccountRestoreBundle,
) {
    let entry = map.entry(acc_id.to_string()).or_default();
    if !patch.favorites.is_empty() {
        entry.favorites = patch.favorites;
    }
    if !patch.playlists.is_empty() {
        entry.playlists = patch.playlists;
    }
    if patch.selection.is_some() {
        entry.selection = patch.selection.take();
    }
    if patch.user_state.is_some() {
        entry.user_state = patch.user_state.take();
    }
    if patch.theme_bg.is_some() {
        entry.theme_bg = patch.theme_bg.take();
    }
}

fn ingest_legacy_info_dir(
    map: &mut BTreeMap<String, AccountRestoreBundle>,
    acc_id: &str,
    info_dir: &Path,
) {
    let mut bundle = AccountRestoreBundle::default();
    let us_path = info_dir.join("user-state.json");
    let us_v1 = info_dir.join("user-state.v1.json");
    let raw = if us_path.is_file() {
        fs::read_to_string(&us_path).ok()
    } else if us_v1.is_file() {
        fs::read_to_string(&us_v1).ok()
    } else {
        None
    };
    if let Some(raw) = raw {
        if let Ok((fav, pls)) = playlists_from_legacy_user_state(&raw) {
            bundle.favorites = fav;
            bundle.playlists = pls;
        }
        if let Ok(ustate) = user_state::user_state_from_legacy_json(&raw) {
            bundle.user_state = Some(ustate);
        }
    }
    let sel_path = info_dir.join("library-selection.json");
    if sel_path.is_file() {
        if let Ok(raw) = fs::read_to_string(&sel_path) {
            bundle.selection = serde_json::from_str(&raw).ok();
        }
    }
    for name in [
        "theme-bg.jpg",
        "theme-bg.jpeg",
        "theme-bg.png",
        "theme-bg.webp",
        "theme-bg.gif",
    ] {
        let p = info_dir.join(name);
        if p.is_file() {
            bundle.theme_bg = Some(p);
            break;
        }
    }
    merge_account_bundle(map, acc_id, bundle);
}

pub(super) fn collect_manifest_accounts(manifest_raw: &str) -> Vec<Account> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(manifest_raw) else {
        return Vec::new();
    };
    accounts::accounts_from_json_value(&v)
}

/// Restore from ZIP bytes (next v3 or legacy v2).
pub async fn restore_backup_zip(
    state: &AppState,
    zip_bytes: impl AsRef<[u8]>,
) -> Result<RestoreReport> {
    if state.is_scanning() {
        bail!("scan already in progress — wait before restore");
    }

    let cursor = Cursor::new(zip_bytes.as_ref());
    let mut archive = ZipArchive::new(cursor).context("open backup zip")?;

    let manifest_raw = read_zip_string(&mut archive, "config/manifest.json")?
        .context("missing config/manifest.json")?;
    let manifest_accounts = collect_manifest_accounts(&manifest_raw);
    let manifest: BackupManifest = serde_json::from_str(&manifest_raw).or_else(|_| {
        let v: serde_json::Value = serde_json::from_str(&manifest_raw)?;
        Ok::<_, anyhow::Error>(BackupManifest {
            kord_backup: v
                .get("kordBackup")
                .or_else(|| v.get("rekordBackup"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            created_at: v
                .get("createdAt")
                .or_else(|| v.get("created_at"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            library_root: v
                .get("libraryRoot")
                .or_else(|| v.get("library_root"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            kind: v
                .get("kind")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
        })
    })?;

    if manifest.kord_backup != 2 && manifest.kord_backup != 3 {
        bail!(
            "unsupported backup version {} (need 2 or 3)",
            manifest.kord_backup
        );
    }

    let mut music_root: Option<PathBuf> = None;
    if let Some(settings) = read_zip_string(&mut archive, "config/settings.json")? {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&settings) {
            if let Some(r) = v.get("music_root").and_then(|x| x.as_str()) {
                music_root = Some(PathBuf::from(r));
            }
        }
        let dest = state.config.lock_or_recover().settings_path();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        if dest.is_file() {
            let bak = dest.with_extension(format!(
                "json.pre-restore.{}",
                chrono::Utc::now().timestamp()
            ));
            let _ = fs::copy(&dest, &bak);
        }
        // Remote admin is a property of this machine, not of the backup.
        let (settings, had_remote_admin) = legacy_config::sanitize_restored_settings(&settings);
        if had_remote_admin {
            warn!("restore: backup had allow_remote_admin=true; reset to false on this machine");
            let data_dir = state.config.lock_or_recover().data_dir.clone();
            crate::diagnostics::log_activity(
                &data_dir,
                crate::diagnostics::ActivityEvent::new(
                    "restore",
                    "remoteAdminIgnored",
                    "allow_remote_admin del backup ignorato (resta disattivato)",
                ),
            );
        }
        fs::write(&dest, settings.as_bytes())?;
        // Sleep prevention follows the restored settings at once.
        {
            let mut cfg = state.config.lock_or_recover();
            cfg.reload_power_settings();
            state.power.configure(cfg.power);
        }
    }
    // Legacy v2 machine config: library root fallback plus Discogs token,
    // Cloudflare login and cookies (only filled where this hub has none).
    let legacy_cfg = read_zip_string(&mut archive, "config/music-root.config.json")?
        .and_then(|raw| legacy_config::parse_legacy_config(&raw));
    if music_root.is_none() {
        music_root = legacy_cfg.as_ref().and_then(|c| c.music_root.clone());
    }
    {
        let zip_token = read_zip_string(&mut archive, "config/discogs-token")?;
        let zip_remote = read_zip_string(&mut archive, "config/remote-access.json")?
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("cloudflareLoggedIn").and_then(|x| x.as_bool()));
        let mut legacy = legacy_cfg.clone().unwrap_or_default();
        legacy.cloudflare_logged_in |= zip_remote == Some(true);
        let mut cfg = state.config.lock_or_recover();
        let imported =
            legacy_config::apply_legacy_config(&mut cfg, &legacy, None, zip_token.as_deref());
        if imported.discogs_token || imported.cloudflare_logged_in || imported.youtube_cookies {
            info!(
                discogs_token = imported.discogs_token,
                cloudflare_logged_in = imported.cloudflare_logged_in,
                youtube_cookies = imported.youtube_cookies,
                "restore: machine settings imported"
            );
        }
    }
    if music_root.is_none() {
        music_root = manifest.library_root.map(PathBuf::from);
    }
    let Some(music_root) = music_root else {
        bail!("backup has no music_root / libraryRoot");
    };
    if !music_root.is_dir() {
        bail!(
            "music root from backup is not a directory on this machine: {}",
            music_root.display()
        );
    }

    {
        let mut cfg = state.config.lock_or_recover();
        cfg.save_music_root(music_root.clone())?;
    }

    if let Some(modules) = read_zip_string(&mut archive, "config/modules.manifest.toml")? {
        let dest = state.config.lock_or_recover().modules_manifest.clone();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, modules)?;
    }

    let data_dir = state.config.lock_or_recover().data_dir.clone();

    // Shared config extras (cookies / activity).
    if let Some(cookies) = read_zip_string(&mut archive, "config/youtube-cookies.txt")? {
        if !cookies.trim().is_empty() {
            let dest = state
                .config
                .lock_or_recover()
                .default_youtube_cookies_path();
            // Owner-only, atomic, and the cookies it replaces are wiped.
            if let Err(e) = crate::ytdlp_cookies::store_upload(&dest, cookies.as_bytes()) {
                tracing::warn!(error = %e, "restore: youtube cookies not written");
            }
            let mut cfg = state.config.lock_or_recover();
            if !cfg.youtube_cookies_from_env {
                cfg.youtube_cookies_path = Some(dest);
            }
        }
    }
    for act_name in [
        "config/kord-activity.log.jsonl",
        "config/rekord-activity.log.jsonl",
    ] {
        if let Some(raw) = read_zip_string(&mut archive, act_name)? {
            if !raw.trim().is_empty() {
                let dest = data_dir.join("activity.jsonl");
                let _ = fs::write(dest, raw.as_bytes());
                break;
            }
        }
    }

    let mut library_files = 0u32;
    library_files += extract_prefix(&mut archive, "libraries/shared/", &music_root)?;
    let lib_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("libraries/") && !n.starts_with("libraries/shared/"))
        .collect();
    for name in lib_names {
        let rest = &name["libraries/".len()..];
        if let Some((_, rel)) = rest.split_once('/') {
            if rel.is_empty() || name.ends_with('/') {
                continue;
            }
            let dest = safe_join(&music_root, rel)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = archive.by_name(&name)?;
            let mut out = File::create(&dest)?;
            std::io::copy(&mut file, &mut out)?;
            library_files += 1;
        }
    }

    let kord_dest = music_root.join(".kord");
    let n_kord = extract_prefix(&mut archive, "kord-db/", &kord_dest)?;
    let n_rekord = extract_prefix(&mut archive, "rekord-db/", &kord_dest)?;
    library_files += n_kord + n_rekord;

    // Registry: config/accounts.json → global_info → manifest.accounts
    let mut registry: Vec<Account> = Vec::new();
    if let Some(acc_raw) = read_zip_string(&mut archive, "config/accounts.json")? {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&acc_raw) {
            registry = accounts::accounts_from_json_value(&v);
        }
    }
    if registry.is_empty() {
        let global = kord_dest.join("global_info").join("accounts.json");
        if global.is_file() {
            if let Ok(raw) = fs::read_to_string(&global) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    registry = accounts::accounts_from_json_value(&v);
                }
            }
        }
    }
    if registry.is_empty() {
        registry = manifest_accounts;
    }

    let mut per_account: BTreeMap<String, AccountRestoreBundle> = BTreeMap::new();

    // Next v3 hub/accounts/{id}/…
    let zip_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    for name in &zip_names {
        let Some(rest) = name.strip_prefix("hub/accounts/") else {
            continue;
        };
        let Some((acc_id, file)) = rest.split_once('/') else {
            continue;
        };
        if acc_id.is_empty() {
            continue;
        }
        let mut patch = AccountRestoreBundle::default();
        match file {
            "favorites.json" => {
                if let Some(raw) = read_zip_string(&mut archive, name)? {
                    patch.favorites = serde_json::from_str(&raw).unwrap_or_default();
                }
            }
            "playlists.json" => {
                if let Some(raw) = read_zip_string(&mut archive, name)? {
                    patch.playlists = serde_json::from_str(&raw).unwrap_or_default();
                }
            }
            "library-selection.json" => {
                if let Some(raw) = read_zip_string(&mut archive, name)? {
                    patch.selection = serde_json::from_str(&raw).ok();
                }
            }
            "user-state.json" => {
                if let Some(raw) = read_zip_string(&mut archive, name)? {
                    // Prefer next-shaped user-state; fall back to legacy converter.
                    if let Ok(ustate) = serde_json::from_str::<UserStateV1>(&raw) {
                        if ustate.version > 0
                            || !ustate.play_counts.is_empty()
                            || !ustate.settings.is_empty()
                        {
                            patch.user_state = Some(ustate);
                        } else if let Ok(ustate) = user_state::user_state_from_legacy_json(&raw) {
                            patch.user_state = Some(ustate);
                        }
                    } else if let Ok(ustate) = user_state::user_state_from_legacy_json(&raw) {
                        patch.user_state = Some(ustate);
                    }
                }
            }
            "theme-bg.jpg" | "theme-bg.jpeg" | "theme-bg.png" | "theme-bg.webp"
            | "theme-bg.gif" => {
                if let Ok(mut zf) = archive.by_name(name) {
                    // `acc_id` comes from the zip entry name: on Windows a
                    // `..\` in it would be a path separator, so build the dir
                    // through the sanitising helper.
                    let tmp = user_state::account_info_dir(&data_dir, acc_id)
                        .join(format!(".restore-{file}"));
                    if let Some(parent) = tmp.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Ok(mut out) = File::create(&tmp) {
                        if std::io::copy(&mut zf, &mut out).is_ok() {
                            patch.theme_bg = Some(tmp);
                        }
                    }
                }
            }
            _ => {}
        }
        merge_account_bundle(&mut per_account, acc_id, patch);
    }

    // Flat hub/* → default (v3 compat)
    {
        let mut patch = AccountRestoreBundle::default();
        if let Some(raw) = read_zip_string(&mut archive, "hub/favorites.json")? {
            patch.favorites = serde_json::from_str(&raw).unwrap_or_default();
        }
        if let Some(raw) = read_zip_string(&mut archive, "hub/playlists.json")? {
            patch.playlists = serde_json::from_str(&raw).unwrap_or_default();
        }
        if !patch.favorites.is_empty() || !patch.playlists.is_empty() {
            merge_account_bundle(&mut per_account, DEFAULT_ACCOUNT_ID, patch);
        }
    }

    // Legacy: every .kord/{id}_info/
    if kord_dest.is_dir() {
        if let Ok(entries) = fs::read_dir(&kord_dest) {
            for ent in entries.flatten() {
                let name = ent.file_name().to_string_lossy().to_string();
                let Some(acc_id) = account_id_from_info_dir_name(&name) else {
                    continue;
                };
                if !ent.path().is_dir() {
                    continue;
                }
                // Fill gaps from legacy *_info without clobbering richer hub/ v3 data.
                let existing = per_account.get(&acc_id);
                let need_core = existing
                    .map(|e| {
                        e.favorites.is_empty() && e.playlists.is_empty() && e.user_state.is_none()
                    })
                    .unwrap_or(true);
                let need_state = existing.map(|e| e.user_state.is_none()).unwrap_or(true);
                let need_sel = existing.map(|e| e.selection.is_none()).unwrap_or(true);
                let need_bg = existing.map(|e| e.theme_bg.is_none()).unwrap_or(true);
                if need_core {
                    ingest_legacy_info_dir(&mut per_account, &acc_id, &ent.path());
                } else {
                    let mut patch = AccountRestoreBundle::default();
                    if need_state {
                        let us_path = ent.path().join("user-state.json");
                        let us_v1 = ent.path().join("user-state.v1.json");
                        let raw = if us_path.is_file() {
                            fs::read_to_string(&us_path).ok()
                        } else if us_v1.is_file() {
                            fs::read_to_string(&us_v1).ok()
                        } else {
                            None
                        };
                        if let Some(raw) = raw {
                            if let Ok(ustate) = user_state::user_state_from_legacy_json(&raw) {
                                patch.user_state = Some(ustate);
                            }
                        }
                    }
                    if need_sel {
                        let sel_path = ent.path().join("library-selection.json");
                        if sel_path.is_file() {
                            if let Ok(raw) = fs::read_to_string(&sel_path) {
                                patch.selection = serde_json::from_str(&raw).ok();
                            }
                        }
                    }
                    if need_bg {
                        for bg in [
                            "theme-bg.jpg",
                            "theme-bg.jpeg",
                            "theme-bg.png",
                            "theme-bg.webp",
                            "theme-bg.gif",
                        ] {
                            let p = ent.path().join(bg);
                            if p.is_file() {
                                patch.theme_bg = Some(p);
                                break;
                            }
                        }
                    }
                    merge_account_bundle(&mut per_account, &acc_id, patch);
                }
            }
        }
    }

    // Fallback: user-state/legacy-config/{id}/user-state.v1.json inside zip
    for name in &zip_names {
        let Some(rest) = name
            .strip_prefix("user-state/legacy-config/")
            .or_else(|| name.strip_prefix("user-state/accounts/"))
        else {
            continue;
        };
        let Some((acc_id, file)) = rest.split_once('/') else {
            continue;
        };
        if !(file == "user-state.json" || file == "user-state.v1.json") {
            continue;
        }
        let existing = per_account.get(acc_id);
        if existing.map(|e| e.user_state.is_some()).unwrap_or(false) {
            continue;
        }
        if let Some(raw) = read_zip_string(&mut archive, name)? {
            let mut patch = AccountRestoreBundle::default();
            if let Ok((fav, pls)) = playlists_from_legacy_user_state(&raw) {
                patch.favorites = fav;
                patch.playlists = pls;
            }
            if let Ok(ustate) = user_state::user_state_from_legacy_json(&raw) {
                patch.user_state = Some(ustate);
            }
            merge_account_bundle(&mut per_account, acc_id, patch);
        }
    }

    // Keep explicit registry accounts; only promote orphans that have real library links
    // (favorites/playlists). Other *_info dirs still get user-state files on disk.
    let mut seen: std::collections::HashSet<String> =
        registry.iter().map(|a| a.id.clone()).collect();
    for (acc_id, bundle) in &per_account {
        if seen.contains(acc_id) {
            continue;
        }
        if acc_id == "route-test" {
            continue;
        }
        if bundle.favorites.is_empty() && bundle.playlists.is_empty() {
            continue;
        }
        seen.insert(acc_id.clone());
        registry.push(Account {
            id: acc_id.clone(),
            name: "Imported".to_string(),
        });
    }

    // Overwrite-by-name: if hub already has "Diego" with a different UUID, apply
    // backup Diego's personal data onto that hub id (and keep the hub id).
    let existing_hub = accounts::ensure_accounts(&data_dir).unwrap_or_default();
    let (registry, id_map) = resolve_restore_account_targets(&registry, &existing_hub);
    let per_account = remap_account_bundles(per_account, &id_map);
    if !id_map.is_empty() {
        let remaps: Vec<String> = id_map
            .iter()
            .filter(|(b, t)| b != t)
            .map(|(b, t)| format!("{b}→{t}"))
            .collect();
        if !remaps.is_empty() {
            info!(?remaps, "restore: remapped backup accounts by name");
        }
    }
    let registry = accounts::replace_accounts_registry(&data_dir, &registry)?;

    // Full library scan then re-link favorites/playlists
    info!(root = %music_root.display(), "restore: scanning library");
    let Some(lease) = state.try_scan_lease() else {
        bail!("could not start scan after restore");
    };
    let db = state.db.clone();
    let root = music_root.clone();
    let scan_opts = scan::ScanOptions {
        embedded: state.embedded_options(),
        ..Default::default()
    };
    let scan_result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        scan::scan_library_opts(&db, &root, scan_opts)
    })
    .await;
    let report = match scan_result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(e),
        Err(e) => bail!("scan join error: {e}"),
    };

    // Legacy v2 stores fetched album/track meta in `.kord/rekord.db` (and sparsely in sidecars).
    // Next scans into its own hub DB — merge those fields after indexing paths.
    let (album_meta_merged, track_meta_merged) =
        match sync_restored_library_metadata(&state.db, &music_root) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "restore: metadata sync failed");
                (0, 0)
            }
        };
    info!(
        album_meta_merged,
        track_meta_merged, "restore: library metadata synced"
    );

    let album_folder_to_id: BTreeMap<String, i64> = state
        .db
        .list_albums()
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.folder_key.replace('\\', "/"), a.id))
        .collect();

    let mut fav_n = 0u32;
    let mut pl_n = 0u32;
    let mut tr_n = 0u32;
    for (acc_id, bundle) in &per_account {
        let _ = accounts::ensure_accounts(&data_dir);
        if let Some(dir) = accounts::account_dir(&data_dir, acc_id) {
            let _ = fs::create_dir_all(&dir);
        }
        fav_n += state
            .db
            .replace_favorites_by_rel_paths(acc_id, &bundle.favorites)?;
        let (p, t) = state
            .db
            .replace_playlists_backup(acc_id, &bundle.playlists)?;
        pl_n += p;
        tr_n += t;
        if let Some(sel) = &bundle.selection {
            let _ = selection::write_library_selection(&data_dir, acc_id, sel);
        }
        if let Some(mut ustate) = bundle.user_state.clone() {
            remap_legacy_excluded_albums(&mut ustate, &album_folder_to_id);
            if let Err(e) = user_state::update_user_state(&data_dir, acc_id, None, |s| *s = ustate)
            {
                warn!(error = %e, account = %acc_id, "failed to save restored user-state");
            }
        }
        if let Some(src) = &bundle.theme_bg {
            let ext = src
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.strip_prefix(".restore-").unwrap_or(n))
                .and_then(|n| Path::new(n).extension())
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");
            let dest = user_state::theme_bg_path_for_ext(&data_dir, acc_id, ext);
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = user_state::delete_theme_bg(&data_dir, acc_id);
            if let Err(e) = fs::copy(src, &dest) {
                warn!(error = %e, account = %acc_id, "failed to copy theme-bg");
            } else if src
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(".restore-"))
                .unwrap_or(false)
            {
                let _ = fs::remove_file(src);
            }
        }
    }

    // Activity from extracted .kord if hub config lacked it.
    let activity_dest = data_dir.join("activity.jsonl");
    if !activity_dest.is_file() {
        for cand in [
            kord_dest
                .join("global_info")
                .join("kord-activity.log.jsonl"),
            kord_dest
                .join("global_info")
                .join("rekord-activity.log.jsonl"),
        ] {
            if cand.is_file() {
                let _ = fs::copy(cand, &activity_dest);
                break;
            }
        }
    }

    info!(
        accounts = registry.len(),
        favorites = fav_n,
        playlists = pl_n,
        playlist_tracks = tr_n,
        library_files,
        tracks = report.indexed_tracks,
        album_meta_merged,
        track_meta_merged,
        "restore complete"
    );

    Ok(RestoreReport {
        restored: true,
        version: manifest.kord_backup,
        favorites: fav_n,
        playlists: pl_n,
        playlist_tracks: tr_n,
        library_files,
        scanned_tracks: report.indexed_tracks,
        album_meta_merged,
        track_meta_merged,
    })
}
