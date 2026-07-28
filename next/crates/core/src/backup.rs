//! Backup / restore ZIP for the next hub (kordBackup: 3) + restore of legacy v2 ZIPs.

use crate::accounts::{self, DEFAULT_ACCOUNT_ID};
use crate::db::{PlaylistBackup, PlaylistBackupTrack};
use crate::scan;
use crate::selection;
use crate::state::AppState;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
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

/// Restore from ZIP bytes (next v3 or legacy v2).
pub async fn restore_backup_zip(state: &AppState, zip_bytes: Vec<u8>) -> Result<RestoreReport> {
    if state.is_scanning() {
        bail!("scan already in progress — wait before restore");
    }

    let cursor = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).context("open backup zip")?;

    let manifest_raw = read_zip_string(&mut archive, "config/manifest.json")?
        .context("missing config/manifest.json")?;
    let manifest: BackupManifest = serde_json::from_str(&manifest_raw)
        .or_else(|_| {
            // legacy used createdAt camelCase without serde rename on all fields
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

    // Resolve music root from settings (v3) or music-root.config.json (v2) or manifest.
    let mut music_root: Option<PathBuf> = None;
    if let Some(settings) = read_zip_string(&mut archive, "config/settings.json")? {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&settings) {
            if let Some(r) = v.get("music_root").and_then(|x| x.as_str()) {
                music_root = Some(PathBuf::from(r));
            }
        }
        // Persist settings file into data_dir
        let dest = state.config.lock().unwrap().settings_path();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        // backup current
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
    if let Some(acc_raw) = read_zip_string(&mut archive, "config/accounts.json")? {
        let dest = accounts::accounts_registry_path(&data_dir);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&dest, acc_raw.as_bytes())?;
    }
    let _ = accounts::ensure_accounts(&data_dir)?;

    let mut library_files = 0u32;
    library_files += extract_prefix(&mut archive, "libraries/shared/", &music_root)?;
    // legacy v1 tags: libraries/<anything>/
    let lib_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("libraries/") && !n.starts_with("libraries/shared/"))
        .collect();
    for name in lib_names {
        // libraries/<tag>/<rel>
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

    // Per-account hub data: hub/accounts/{id}/… plus flat hub/* → default.
    let mut per_account: std::collections::BTreeMap<
        String,
        (Vec<String>, Vec<PlaylistBackup>, Option<selection::LibrarySelection>),
    > = std::collections::BTreeMap::new();

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
        let entry = per_account
            .entry(acc_id.to_string())
            .or_insert_with(|| (Vec::new(), Vec::new(), None));
        if let Some(raw) = read_zip_string(&mut archive, name)? {
            match file {
                "favorites.json" => {
                    entry.0 = serde_json::from_str(&raw).unwrap_or_default();
                }
                "playlists.json" => {
                    entry.1 = serde_json::from_str(&raw).unwrap_or_default();
                }
                "library-selection.json" => {
                    entry.2 = serde_json::from_str(&raw).ok();
                }
                _ => {}
            }
        }
    }

    let mut favorites: Vec<String> = Vec::new();
    let mut playlists: Vec<PlaylistBackup> = Vec::new();
    if let Some(raw) = read_zip_string(&mut archive, "hub/favorites.json")? {
        favorites = serde_json::from_str(&raw).unwrap_or_default();
    }
    if let Some(raw) = read_zip_string(&mut archive, "hub/playlists.json")? {
        playlists = serde_json::from_str(&raw).unwrap_or_default();
    }

    if per_account.is_empty() && favorites.is_empty() && playlists.is_empty() {
        // Probe extracted .kord for user-state.json
        if kord_dest.is_dir() {
            for entry in WalkDir::new(&kord_dest).into_iter().filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy();
                if name != "user-state.json" && name != "user-state.v1.json" {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(entry.path()) {
                    if let Ok((fav, pls)) = playlists_from_legacy_user_state(&raw) {
                        if favorites.is_empty() {
                            favorites = fav;
                        }
                        if playlists.is_empty() {
                            playlists = pls;
                        }
                        break;
                    }
                }
            }
        }
    }

    if !per_account.contains_key(DEFAULT_ACCOUNT_ID)
        && (!favorites.is_empty() || !playlists.is_empty())
    {
        per_account.insert(
            DEFAULT_ACCOUNT_ID.to_string(),
            (favorites, playlists, None),
        );
    } else if per_account.is_empty() {
        per_account.insert(
            DEFAULT_ACCOUNT_ID.to_string(),
            (favorites, playlists, None),
        );
    }

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

    let mut fav_n = 0u32;
    let mut pl_n = 0u32;
    let mut tr_n = 0u32;
    for (acc_id, (favs, pls, sel)) in &per_account {
        let _ = accounts::ensure_accounts(&data_dir);
        // Ensure account dir exists even if not in registry (edge case).
        if let Some(dir) = accounts::account_dir(&data_dir, acc_id) {
            let _ = fs::create_dir_all(dir);
        }
        fav_n += state.db.replace_favorites_by_rel_paths(acc_id, favs)?;
        let (p, t) = state.db.replace_playlists_backup(acc_id, pls)?;
        pl_n += p;
        tr_n += t;
        if let Some(sel) = sel {
            let _ = selection::write_library_selection(&data_dir, acc_id, sel);
        }
    }

    info!(
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
