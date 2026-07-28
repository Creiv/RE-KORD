//! Backup / restore ZIP for the next hub (kordBackup: 3) + restore of legacy v2 ZIPs.

use crate::accounts::{self, Account, DEFAULT_ACCOUNT_ID};
use crate::db::{PlaylistBackup, PlaylistBackupTrack};
use crate::scan;
use crate::selection;
use crate::state::AppState;
use crate::user_state::{self, UserStateV1};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use tracing::{info, warn};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const BACKUP_VERSION: u32 = 3;

const LIBRARY_SIDECAR_NAMES: &[&str] = &[
    "kord-albuminfo.json",
    "wpp-albuminfo.json",
    "kord-trackinfo.json",
    "wpp-trackinfo.json",
    "kord-artistinfo.json",
    "kord-artistinfo.jpg",
    "linked-source.json",
    "cover.jpg",
    "folder.jpg",
    "front.jpg",
    "cover.png",
    "folder.png",
    "artwork.jpg",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    #[serde(rename = "kordBackup", alias = "rekordBackup")]
    pub kord_backup: u32,
    pub created_at: String,
    #[serde(default)]
    pub library_root: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreReport {
    pub restored: bool,
    pub version: u32,
    pub favorites: u32,
    pub playlists: u32,
    pub playlist_tracks: u32,
    pub library_files: u32,
    pub scanned_tracks: u64,
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

fn add_bytes<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    data: &[u8],
) -> Result<()> {
    zip.start_file(name, zip_options())?;
    zip.write_all(data)?;
    Ok(())
}

fn add_file_path<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    abs: &Path,
    zip_name: &str,
) -> Result<()> {
    let data = fs::read(abs).with_context(|| format!("read {}", abs.display()))?;
    add_bytes(zip, zip_name, &data)
}

fn collect_library_sidecars(music_root: &Path) -> Vec<(PathBuf, String)> {
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

fn collect_kord_dir(music_root: &Path) -> Vec<(PathBuf, String)> {
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
        let cfg = state.config.lock().unwrap();
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
            let cfg = state.config.lock().unwrap();
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

fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let mut out = base.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => bail!("unsafe path in zip: {rel}"),
        }
    }
    Ok(out)
}

fn read_zip_string(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<Option<String>> {
    match archive.by_name(name) {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s)?;
            Ok(Some(s))
        }
        Err(_) => Ok(None),
    }
}

fn extract_prefix(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    prefix: &str,
    dest_root: &Path,
) -> Result<u32> {
    let mut n = 0u32;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    for name in names {
        if !name.starts_with(prefix) || name.ends_with('/') {
            continue;
        }
        let rel = &name[prefix.len()..];
        if rel.is_empty() {
            continue;
        }
        let dest = safe_join(dest_root, rel)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = archive.by_name(&name)?;
        let mut out = File::create(&dest)?;
        std::io::copy(&mut file, &mut out)?;
        n += 1;
    }
    Ok(n)
}

#[derive(Default)]
struct AccountRestoreBundle {
    favorites: Vec<String>,
    playlists: Vec<PlaylistBackup>,
    selection: Option<selection::LibrarySelection>,
    user_state: Option<UserStateV1>,
    theme_bg: Option<PathBuf>,
}

fn playlists_from_legacy_user_state(raw: &str) -> Result<(Vec<String>, Vec<PlaylistBackup>)> {
    let v: serde_json::Value = serde_json::from_str(raw)?;
    let favorites = v
        .get("favorites")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut playlists = Vec::new();
    if let Some(arr) = v.get("playlists").and_then(|x| x.as_array()) {
        for pl in arr {
            let name = pl
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("Playlist")
                .to_string();
            let mut tracks = Vec::new();
            if let Some(ts) = pl.get("tracks").and_then(|x| x.as_array()) {
                for t in ts {
                    let rel = t
                        .get("relPath")
                        .or_else(|| t.get("rel_path"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if rel.is_empty() {
                        continue;
                    }
                    tracks.push(PlaylistBackupTrack {
                        rel_path: rel,
                        title: t
                            .get("title")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        artist_name: t
                            .get("artist")
                            .or_else(|| t.get("artist_name"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        album_name: t
                            .get("album")
                            .or_else(|| t.get("album_name"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
            }
            playlists.push(PlaylistBackup { name, tracks });
        }
    }
    Ok((favorites, playlists))
}

fn account_id_from_info_dir_name(name: &str) -> Option<String> {
    let id = name.strip_suffix("_info")?;
    if id.is_empty() || id == "global" {
        return None;
    }
    Some(id.to_string())
}

fn legacy_album_key_to_folder(key: &str) -> String {
    if key.contains("::") {
        key.replacen("::", "/", 1).replace('\\', "/")
    } else {
        key.replace('\\', "/")
    }
}

fn remap_legacy_excluded_albums(state: &mut UserStateV1, album_folder_to_id: &BTreeMap<String, i64>) {
    let Some(keys_val) = state.settings.remove("legacyExcludedAlbumKeys") else {
        return;
    };
    let Some(arr) = keys_val.as_array() else {
        return;
    };
    let mut seen: std::collections::HashSet<i64> =
        state.excluded_album_ids.iter().copied().collect();
    for item in arr {
        let Some(key) = item.as_str() else { continue };
        let folder = legacy_album_key_to_folder(key);
        if let Some(id) = album_folder_to_id.get(&folder) {
            if seen.insert(*id) {
                state.excluded_album_ids.push(*id);
            }
        }
    }
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

fn collect_manifest_accounts(manifest_raw: &str) -> Vec<Account> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(manifest_raw) else {
        return Vec::new();
    };
    accounts::accounts_from_json_value(&v)
}

/// Restore from ZIP bytes (next v3 or legacy v2).
pub async fn restore_backup_zip(state: &AppState, zip_bytes: Vec<u8>) -> Result<RestoreReport> {
    if state.is_scanning() {
        bail!("scan already in progress — wait before restore");
    }

    let cursor = Cursor::new(zip_bytes);
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
        let dest = state.config.lock().unwrap().settings_path();
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
        fs::write(&dest, settings.as_bytes())?;
    }
    if music_root.is_none() {
        if let Some(raw) = read_zip_string(&mut archive, "config/music-root.config.json")? {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(r) = v
                    .get("musicRoot")
                    .or_else(|| v.get("libraryRoot"))
                    .and_then(|x| x.as_str())
                {
                    music_root = Some(PathBuf::from(r));
                }
            }
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
        let mut cfg = state.config.lock().unwrap();
        cfg.save_music_root(music_root.clone())?;
    }

    if let Some(modules) = read_zip_string(&mut archive, "config/modules.manifest.toml")? {
        let dest = state.config.lock().unwrap().modules_manifest.clone();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, modules)?;
    }

    let data_dir = state.config.lock().unwrap().data_dir.clone();

    // Shared config extras (cookies / activity).
    if let Some(cookies) = read_zip_string(&mut archive, "config/youtube-cookies.txt")? {
        if !cookies.trim().is_empty() {
            let dest = state
                .config
                .lock()
                .unwrap()
                .default_youtube_cookies_path();
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&dest, cookies.as_bytes());
            let mut cfg = state.config.lock().unwrap();
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
            "theme-bg.jpg" | "theme-bg.jpeg" | "theme-bg.png" | "theme-bg.webp" | "theme-bg.gif" => {
                if let Ok(mut zf) = archive.by_name(name) {
                    let tmp = data_dir
                        .join("accounts")
                        .join(format!("{acc_id}_info"))
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
                    .map(|e| e.favorites.is_empty() && e.playlists.is_empty() && e.user_state.is_none())
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
    let registry = accounts::replace_accounts_registry(&data_dir, &registry)?;

    // Full library scan then re-link favorites/playlists
    info!(root = %music_root.display(), "restore: scanning library");
    if !state.try_begin_scan() {
        bail!("could not start scan after restore");
    }
    let db = state.db.clone();
    let root = music_root.clone();
    let scan_result = tokio::task::spawn_blocking(move || scan::scan_library(&db, &root)).await;
    state.end_scan();
    let report = match scan_result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(e),
        Err(e) => bail!("scan join error: {e}"),
    };

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
            if let Err(e) = user_state::save_user_state(&data_dir, acc_id, &ustate) {
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
            kord_dest.join("global_info").join("kord-activity.log.jsonl"),
            kord_dest.join("global_info").join("rekord-activity.log.jsonl"),
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
    })
}
