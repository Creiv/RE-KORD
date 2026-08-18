//! Backup / restore ZIP for the next hub (kordBackup: 3) + restore of legacy v2 ZIPs.

use crate::accounts::{self, Account, DEFAULT_ACCOUNT_ID};
use crate::db::{Db, PlaylistBackup, PlaylistBackupTrack};
use crate::metadata::providers::{DiscogsAlbumExtra, FetchedAlbumMeta, FetchedTrackMeta};
use crate::scan;
use crate::selection;
use crate::state::AppState;
use crate::user_state::{self, UserStateV1};
use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use tracing::{info, warn};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const BACKUP_VERSION: u32 = 3;
const THEME_EXPORT_JSON: &str = "rekord-theme.json";

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
    pub album_meta_merged: u32,
    pub track_meta_merged: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeImportReport {
    pub theme_imported: bool,
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glass_surfaces: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glass_opacity: Option<f64>,
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

/// Shareable theme package (legacy-compatible): `rekord-theme/rekord-theme.json` + optional background.
pub fn build_theme_export_zip(state: &AppState, account_id: &str) -> Result<(Vec<u8>, String)> {
    let data_dir = state.config.lock().unwrap().data_dir.clone();
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

fn find_theme_json_entry(archive: &mut ZipArchive<Cursor<Vec<u8>>>) -> Option<String> {
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

fn mime_for_theme_bg_name(name: &str) -> &'static str {
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
    zip_bytes: Vec<u8>,
) -> Result<Option<ThemeImportReport>> {
    let cursor = Cursor::new(zip_bytes);
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

    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let mut ustate = user_state::load_user_state(&data_dir, account_id);

    if let Some(theme) = payload.get("theme").and_then(|v| v.as_str()) {
        if !theme.trim().is_empty() {
            ustate.settings.insert("theme".into(), json!(theme.trim()));
        }
    }
    if let Some(gs) = payload.get("glassSurfaces").and_then(|v| v.as_bool()) {
        ustate.settings.insert("glassSurfaces".into(), json!(gs));
    }
    if let Some(op) = payload.get("glassOpacity") {
        if op.as_f64().is_some() || op.as_u64().is_some() || op.as_i64().is_some() {
            ustate.settings.insert("glassOpacity".into(), op.clone());
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
        ustate.settings.insert("customTheme".into(), ct);
    }

    ustate.revision = ustate.revision.saturating_add(1);
    user_state::save_user_state(&data_dir, account_id, &ustate)?;

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

fn read_zip_string(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    name: &str,
) -> Result<Option<String>> {
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

fn remap_legacy_excluded_albums(
    state: &mut UserStateV1,
    album_folder_to_id: &BTreeMap<String, i64>,
) {
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

fn account_name_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_ascii_lowercase()
}

/// Map backup account ids onto existing hub ids when the display name matches
/// (case-insensitive). Same-id always wins; `default` always stays `default`.
/// Returns `(registry with target ids + backup names, backup_id → target_id)`.
fn resolve_restore_account_targets(
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

fn collect_manifest_accounts(manifest_raw: &str) -> Vec<Account> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(manifest_raw) else {
        return Vec::new();
    };
    accounts::accounts_from_json_value(&v)
}

fn json_str_field(obj: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn json_i64_field(obj: &Value, keys: &[&str]) -> Option<i64> {
    for k in keys {
        let Some(v) = obj.get(*k) else { continue };
        if let Some(n) = v.as_i64() {
            return Some(n);
        }
        if let Some(n) = v.as_u64() {
            return Some(n as i64);
        }
        if let Some(s) = v.as_str() {
            if let Ok(n) = s.trim().parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

/// Drop 1-char / short-numeric stubs that are not real studio metadata.
fn scrub_studio_str(v: Option<String>) -> Option<String> {
    let s = v?.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if s.len() == 1 {
        return None;
    }
    if s.len() <= 2 && s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(s)
}

/// Like [`scrub_studio_str`], also drops generic ID3 genre stubs (`Music`, `Unknown`, …).
fn scrub_studio_genre(v: Option<String>) -> Option<String> {
    let s = scrub_studio_str(v)?;
    if crate::db::is_weak_genre(Some(&s)) {
        None
    } else {
        Some(s)
    }
}

fn album_meta_from_sidecar_json(json: &Value) -> Option<FetchedAlbumMeta> {
    if !json.is_object() {
        return None;
    }
    let title = json_str_field(json, &["title"]);
    let release_date = scrub_studio_str(json_str_field(
        json,
        &["releaseDate", "release_date", "date"],
    ));
    let genre = scrub_studio_genre(json_str_field(json, &["genre"]));
    let label = scrub_studio_str(json_str_field(json, &["label"]));
    let country = json_str_field(json, &["country"]).and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let source = json_str_field(json, &["source"]);
    let musicbrainz_release_id =
        json_str_field(json, &["musicbrainzReleaseId", "musicbrainz_release_id"]);
    let discogs_release_id = json_i64_field(json, &["discogsReleaseId", "discogs_release_id"])
        .map(|n| n.to_string())
        .or_else(|| json_str_field(json, &["discogsReleaseId", "discogs_release_id"]));
    let discogs_extra_value = json
        .get("discogsExtra")
        .or_else(|| json.get("discogs_extra"))
        .filter(|v| v.is_object())
        .cloned();
    let discogs_extra = discogs_extra_value
        .as_ref()
        .and_then(|v| serde_json::from_value::<DiscogsAlbumExtra>(v.clone()).ok())
        .filter(|e| {
            e.master_id.is_some()
                || e.discogs_uri.as_ref().is_some_and(|s| !s.trim().is_empty())
                || e.format_summary
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty())
                || e.catalog_no.as_ref().is_some_and(|s| !s.trim().is_empty())
        });
    let discogs_extra_json = discogs_extra_value.and_then(|v| serde_json::to_string(&v).ok());
    let discogs_uri = json_str_field(json, &["discogsUri", "discogs_uri"]).or_else(|| {
        discogs_extra
            .as_ref()
            .and_then(|e| e.discogs_uri.clone())
            .filter(|s| !s.trim().is_empty())
    });
    if title.is_none()
        && release_date.is_none()
        && genre.is_none()
        && label.is_none()
        && country.is_none()
        && musicbrainz_release_id.is_none()
        && discogs_release_id.is_none()
        && discogs_uri.is_none()
        && discogs_extra.is_none()
    {
        return None;
    }
    Some(FetchedAlbumMeta {
        ok: true,
        title,
        release_date,
        genre,
        label,
        country,
        source,
        musicbrainz_release_id,
        discogs_release_id,
        discogs_uri,
        discogs_extra,
        discogs_extra_json,
        expected_track_count: None,
    })
}

fn track_meta_from_sidecar_json(json: &Value) -> Option<FetchedTrackMeta> {
    if !json.is_object() {
        return None;
    }
    let title = json_str_field(json, &["title"]);
    let release_date = scrub_studio_str(json_str_field(
        json,
        &["releaseDate", "release_date", "date"],
    ));
    let genre = scrub_studio_genre(json_str_field(json, &["genre"]));
    let lyrics = json_str_field(json, &["lyrics"]);
    let source = json_str_field(json, &["source"]);
    let url = json_str_field(json, &["url"]);
    let duration_ms = json_i64_field(json, &["durationMs", "duration_ms"]);
    if title.is_none()
        && release_date.is_none()
        && genre.is_none()
        && lyrics.is_none()
        && source.is_none()
        && url.is_none()
    {
        return None;
    }
    Some(FetchedTrackMeta {
        ok: true,
        title,
        release_date,
        genre,
        lyrics,
        track_number: None,
        disc_number: None,
        source,
        url,
        duration_ms,
    })
}

/// Import album/track studio metadata from restored library sidecar JSON files.
/// Parity with legacy `importLegacyAlbumMetaToDb` / `importLegacyTrackMetaMapToDb`.
pub fn import_sidecar_metadata(db: &Db, music_root: &Path) -> Result<(u32, u32)> {
    let mut albums = 0u32;
    let mut tracks = 0u32;
    if !music_root.is_dir() {
        return Ok((0, 0));
    }
    for entry in WalkDir::new(music_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let name = entry.file_name().to_string_lossy();
        let is_album = matches!(name.as_ref(), "kord-albuminfo.json" | "wpp-albuminfo.json");
        let is_track = matches!(name.as_ref(), "kord-trackinfo.json" | "wpp-trackinfo.json");
        if !is_album && !is_track {
            continue;
        }
        let abs = entry.path();
        let Ok(rel) = abs.strip_prefix(music_root) else {
            continue;
        };
        if rel.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some(".kord" | ".rekord" | ".wpp" | "node_modules" | ".git")
            )
        }) {
            continue;
        }
        let Some(parent) = abs.parent() else {
            continue;
        };
        let Ok(folder_rel) = parent.strip_prefix(music_root) else {
            continue;
        };
        let folder_key = folder_rel.to_string_lossy().replace('\\', "/");
        let Ok(raw) = fs::read_to_string(abs) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if is_album {
            if let Some(meta) = album_meta_from_sidecar_json(&json) {
                if db
                    .fill_album_meta_empty(&folder_key, &meta)
                    .unwrap_or(false)
                {
                    albums += 1;
                }
            }
        } else if let Some(map) = json.as_object() {
            for (file_name, meta_v) in map {
                let Some(meta) = track_meta_from_sidecar_json(meta_v) else {
                    continue;
                };
                let Ok(Some(rel_path)) = db.resolve_track_rel_in_album(&folder_key, file_name)
                else {
                    continue;
                };
                if db.fill_track_meta_empty(&rel_path, &meta).unwrap_or(false) {
                    tracks += 1;
                }
            }
        }
    }
    Ok((albums, tracks))
}

/// Merge album/track studio metadata from a restored legacy `.kord/rekord.db`.
/// Next keeps its own hub DB; v2 backups store fetched meta in the library SQLite, not only sidecars.
pub fn import_legacy_library_db_metadata(db: &Db, legacy_db_path: &Path) -> Result<(u32, u32)> {
    if !legacy_db_path.is_file() {
        return Ok((0, 0));
    }
    let legacy = Connection::open_with_flags(legacy_db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open legacy db {}", legacy_db_path.display()))?;

    let mut albums = 0u32;
    let mut tracks = 0u32;

    {
        let has_discogs_extra = legacy
            .prepare("PRAGMA table_info(albums)")
            .ok()
            .map(|mut s| {
                s.query_map([], |r| r.get::<_, String>(1))
                    .ok()
                    .map(|rows| {
                        rows.filter_map(|r| r.ok())
                            .any(|name| name == "discogs_extra_json")
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let sql = if has_discogs_extra {
            r#"
            SELECT folder_rel_path, title, release_date, genre, label, country,
                   musicbrainz_release_id, discogs_release_id, expected_track_count,
                   discogs_extra_json
            FROM albums
            WHERE has_album_meta = 1
               OR (title IS NOT NULL AND trim(title) != '')
               OR (genre IS NOT NULL AND trim(genre) != '')
               OR (label IS NOT NULL AND trim(label) != '')
               OR (release_date IS NOT NULL AND trim(release_date) != '')
               OR (country IS NOT NULL AND trim(country) != '')
               OR (musicbrainz_release_id IS NOT NULL AND trim(musicbrainz_release_id) != '')
               OR discogs_release_id IS NOT NULL
               OR (discogs_extra_json IS NOT NULL AND trim(discogs_extra_json) != '')
            "#
        } else {
            r#"
            SELECT folder_rel_path, title, release_date, genre, label, country,
                   musicbrainz_release_id, discogs_release_id, expected_track_count,
                   NULL AS discogs_extra_json
            FROM albums
            WHERE has_album_meta = 1
               OR (title IS NOT NULL AND trim(title) != '')
               OR (genre IS NOT NULL AND trim(genre) != '')
               OR (label IS NOT NULL AND trim(label) != '')
               OR (release_date IS NOT NULL AND trim(release_date) != '')
               OR (country IS NOT NULL AND trim(country) != '')
               OR (musicbrainz_release_id IS NOT NULL AND trim(musicbrainz_release_id) != '')
               OR discogs_release_id IS NOT NULL
            "#
        };
        let mut stmt = legacy.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })?;
        for row in rows.flatten() {
            let (
                folder,
                title,
                release_date,
                genre,
                label,
                country,
                mb_id,
                discogs_id,
                expected_track_count,
                discogs_extra_json,
            ) = row;
            let folder_key = folder.replace('\\', "/");
            let raw_extra = discogs_extra_json
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let discogs_extra = raw_extra
                .as_deref()
                .and_then(|s| serde_json::from_str::<DiscogsAlbumExtra>(s).ok());
            let discogs_uri = discogs_extra
                .as_ref()
                .and_then(|e| e.discogs_uri.clone())
                .filter(|s| !s.trim().is_empty());
            let meta = FetchedAlbumMeta {
                ok: true,
                title: title.filter(|s| !s.trim().is_empty()),
                release_date: release_date.filter(|s| !s.trim().is_empty()),
                genre: scrub_studio_genre(genre.filter(|s| !s.trim().is_empty())),
                label: label.filter(|s| !s.trim().is_empty()),
                country: country.filter(|s| !s.trim().is_empty()),
                source: None,
                musicbrainz_release_id: mb_id.filter(|s| !s.trim().is_empty()),
                discogs_release_id: discogs_id.map(|n| n.to_string()),
                discogs_uri,
                discogs_extra,
                discogs_extra_json: raw_extra,
                expected_track_count,
            };
            if db
                .fill_album_meta_empty(&folder_key, &meta)
                .unwrap_or(false)
            {
                albums += 1;
            }
        }
    }

    {
        let mut stmt = legacy.prepare(
            r#"
            SELECT rel_path, title, genre, release_date, lyrics, source, url
            FROM tracks
            WHERE (source IS NOT NULL AND trim(source) != '')
               OR (url IS NOT NULL AND trim(url) != '')
               OR (lyrics IS NOT NULL AND trim(lyrics) != '')
               OR (genre IS NOT NULL AND trim(genre) != '')
               OR (release_date IS NOT NULL AND trim(release_date) != '')
            "#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        for row in rows.flatten() {
            let (rel_path, title, genre, release_date, lyrics, source, url) = row;
            let rel = rel_path.replace('\\', "/");
            let meta = FetchedTrackMeta {
                ok: true,
                // Prefer not to clobber scan titles unless empty (fill_* handles that).
                title: title.filter(|s| !s.trim().is_empty()),
                release_date: release_date.filter(|s| !s.trim().is_empty()),
                genre: scrub_studio_genre(genre.filter(|s| !s.trim().is_empty())),
                lyrics: lyrics.filter(|s| !s.trim().is_empty()),
                track_number: None,
                disc_number: None,
                source: source.filter(|s| !s.trim().is_empty()),
                url: url.filter(|s| !s.trim().is_empty()),
                duration_ms: None,
            };
            if db.fill_track_meta_empty(&rel, &meta).unwrap_or(false) {
                tracks += 1;
            }
        }
    }

    Ok((albums, tracks))
}

/// After a restore scan: sync metadata from sidecars + restored legacy library DB.
pub fn sync_restored_library_metadata(db: &Db, music_root: &Path) -> Result<(u32, u32)> {
    let (mut albums, mut tracks) = import_sidecar_metadata(db, music_root)?;
    let legacy_db = music_root.join(".kord").join("rekord.db");
    let (a2, t2) = import_legacy_library_db_metadata(db, &legacy_db)?;
    albums += a2;
    tracks += t2;
    Ok((albums, tracks))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySyncReport {
    pub album_meta_merged: u32,
    pub track_meta_merged: u32,
    pub accounts_moods_synced: u32,
    pub moods_imported: u32,
    pub favorites_linked: u32,
    pub playlists_imported: u32,
    pub playlist_tracks_linked: u32,
    pub selections_imported: u32,
    pub accounts_registry: u32,
}

#[derive(Debug, Clone, Copy)]
pub enum MoodImportMode {
    /// Insert missing mood keys only (safe after routine scans).
    FillEmpty,
    /// Replace hub moods with legacy `.kord` map (repair / one-shot sync).
    ReplaceFromLegacy,
}

/// Import per-account moods (and fill play counts / recent gaps) from
/// `music_root/.kord/{account}_info/user-state.json` into the hub data_dir.
pub fn import_legacy_account_user_state(
    data_dir: &Path,
    music_root: &Path,
    mode: MoodImportMode,
) -> Result<(u32, u32)> {
    let kord = music_root.join(".kord");
    if !kord.is_dir() {
        return Ok((0, 0));
    }
    let mut accounts = 0u32;
    let mut moods = 0u32;
    for entry in fs::read_dir(&kord).with_context(|| format!("read {}", kord.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(account_id) = name.strip_suffix("_info") else {
            continue;
        };
        if account_id.is_empty() || account_id == "global" {
            continue;
        }
        let legacy_path = entry.path().join("user-state.json");
        if !legacy_path.is_file() {
            continue;
        }
        let raw = match fs::read_to_string(&legacy_path) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, path = %legacy_path.display(), "skip legacy user-state");
                continue;
            }
        };
        let Ok(legacy_val) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let has_legacy_shape = legacy_val.get("trackPlayCounts").is_some()
            || legacy_val.get("favorites").is_some()
            || legacy_val.get("trackMoods").is_some()
            || legacy_val.get("recent").is_some();
        let converted = if has_legacy_shape {
            match user_state::user_state_from_legacy_json(&raw) {
                Ok(s) => s,
                Err(e) => {
                    warn!(error = %e, path = %legacy_path.display(), "legacy user-state convert failed");
                    continue;
                }
            }
        } else if let Ok(s) = serde_json::from_str::<UserStateV1>(&raw) {
            s
        } else {
            continue;
        };

        let mut hub = user_state::load_user_state(data_dir, account_id);
        let mut changed = false;

        match mode {
            MoodImportMode::ReplaceFromLegacy => {
                if legacy_val.get("trackMoods").is_some() || !converted.track_moods.is_empty() {
                    if hub.track_moods != converted.track_moods {
                        moods += converted.track_moods.len() as u32;
                        hub.track_moods = converted.track_moods.clone();
                        changed = true;
                    }
                }
            }
            MoodImportMode::FillEmpty => {
                for (k, v) in &converted.track_moods {
                    if !hub.track_moods.contains_key(k) {
                        hub.track_moods.insert(k.clone(), v.clone());
                        moods += 1;
                        changed = true;
                    }
                }
            }
        }

        for (k, v) in converted.play_counts {
            let cur = hub
                .play_counts
                .get(&k)
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let n = v.as_u64().unwrap_or(0);
            if n > cur {
                hub.play_counts.insert(k, Value::from(n));
                changed = true;
            }
        }
        if hub.recent_rel_paths.is_empty() && !converted.recent_rel_paths.is_empty() {
            hub.recent_rel_paths = converted.recent_rel_paths;
            changed = true;
        }
        match mode {
            MoodImportMode::ReplaceFromLegacy => {
                if hub.excluded_rel_paths != converted.excluded_rel_paths {
                    hub.excluded_rel_paths = converted.excluded_rel_paths.clone();
                    changed = true;
                }
                // Full replace (including clearing hub-only album blocks).
                // String keys remapped by `import_legacy_accounts_personal_data`.
                if hub.excluded_album_ids != converted.excluded_album_ids {
                    hub.excluded_album_ids = converted.excluded_album_ids.clone();
                    changed = true;
                }
                if let Some(keys) = converted.settings.get("legacyExcludedAlbumKeys") {
                    if hub.settings.get("legacyExcludedAlbumKeys") != Some(keys) {
                        hub.settings
                            .insert("legacyExcludedAlbumKeys".into(), keys.clone());
                        changed = true;
                    }
                }
                if !converted.settings.is_empty() {
                    for (k, v) in &converted.settings {
                        if k == "legacyExcludedAlbumKeys" {
                            continue;
                        }
                        if hub.settings.get(k) != Some(v) {
                            hub.settings.insert(k.clone(), v.clone());
                            changed = true;
                        }
                    }
                }
            }
            MoodImportMode::FillEmpty => {
                if hub.excluded_rel_paths.is_empty() && !converted.excluded_rel_paths.is_empty() {
                    hub.excluded_rel_paths = converted.excluded_rel_paths;
                    changed = true;
                }
            }
        }

        if changed {
            hub.revision = hub.revision.saturating_add(1).max(1);
            user_state::save_user_state(data_dir, account_id, &hub)?;
            accounts += 1;
        }
    }
    Ok((accounts, moods))
}

fn normalize_import_rel_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.starts_with('/') {
        s = s[1..].to_string();
    }
    s = s.replace("/Tracce/", "/Tracks/");
    if s.starts_with("Tracce/") {
        s = format!("Tracks/{}", &s["Tracce/".len()..]);
    }
    s
}

fn load_legacy_accounts_registry(music_root: &Path) -> Vec<Account> {
    let global_accounts = music_root
        .join(".kord")
        .join("global_info")
        .join("accounts.json");
    let Ok(raw) = fs::read_to_string(&global_accounts) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(arr) = v.get("accounts").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for a in arr {
        let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").trim();
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("").trim();
        if id.is_empty() {
            continue;
        }
        list.push(Account {
            id: id.to_string(),
            name: if name.is_empty() {
                if id == DEFAULT_ACCOUNT_ID {
                    "Locale".to_string()
                } else {
                    "Account".to_string()
                }
            } else {
                name.to_string()
            },
        });
    }
    list
}

/// Import registry + per-account favorites, playlists, selection, theme-bg and full user-state
/// from `music_root/.kord` into the hub (replace semantics for personal data).
/// Returns `(accounts, moods, favorites, playlists, playlist_tracks, selections, registry)`.
pub fn import_legacy_accounts_personal_data(
    db: &Db,
    data_dir: &Path,
    music_root: &Path,
) -> Result<(u32, u32, u32, u32, u32, u32, u32)> {
    let kord = music_root.join(".kord");
    if !kord.is_dir() {
        return Ok((0, 0, 0, 0, 0, 0, 0));
    }

    let mut registry_n = 0u32;
    let list = load_legacy_accounts_registry(music_root);
    if !list.is_empty() {
        registry_n = accounts::replace_accounts_registry(data_dir, &list)?.len() as u32;
    }
    let _ = accounts::ensure_accounts(data_dir);

    let album_folder_to_id: BTreeMap<String, i64> = db
        .list_albums()
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.folder_key.replace('\\', "/"), a.id))
        .collect();

    let mut accounts_synced = 0u32;
    let mut moods_imported = 0u32;
    let mut favorites_linked = 0u32;
    let mut playlists_imported = 0u32;
    let mut playlist_tracks_linked = 0u32;
    let mut selections_imported = 0u32;

    for entry in fs::read_dir(&kord).with_context(|| format!("read {}", kord.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(account_id) = account_id_from_info_dir_name(&name) else {
            continue;
        };
        let info_dir = entry.path();
        let mut touched = false;

        let legacy_path = info_dir.join("user-state.json");
        if legacy_path.is_file() {
            let raw = match fs::read_to_string(&legacy_path) {
                Ok(s) => s,
                Err(e) => {
                    warn!(error = %e, path = %legacy_path.display(), "skip legacy user-state");
                    String::new()
                }
            };
            if !raw.is_empty() {
                if let Ok((fav, pls)) = playlists_from_legacy_user_state(&raw) {
                    let fav: Vec<String> = fav
                        .into_iter()
                        .map(|p| normalize_import_rel_path(&p))
                        .filter(|p| !p.is_empty())
                        .collect();
                    let mut pls_norm = pls;
                    for pl in &mut pls_norm {
                        for t in &mut pl.tracks {
                            t.rel_path = normalize_import_rel_path(&t.rel_path);
                        }
                    }
                    favorites_linked += db.replace_favorites_by_rel_paths(&account_id, &fav)?;
                    let (p, t) = db.replace_playlists_backup(&account_id, &pls_norm)?;
                    playlists_imported += p;
                    playlist_tracks_linked += t;
                    touched = true;
                }
                match user_state::user_state_from_legacy_json(&raw) {
                    Ok(mut ustate) => {
                        moods_imported += ustate.track_moods.len() as u32;
                        remap_legacy_excluded_albums(&mut ustate, &album_folder_to_id);
                        user_state::save_user_state(data_dir, &account_id, &ustate)?;
                        touched = true;
                    }
                    Err(e) => {
                        warn!(
                            error = %e,
                            path = %legacy_path.display(),
                            "legacy user-state convert failed"
                        );
                    }
                }
            }
        }

        // Selection may live under *_info (legacy) — next uses accounts/{id}/.
        let sel_src = info_dir.join("library-selection.json");
        if sel_src.is_file() {
            if let Ok(raw) = fs::read_to_string(&sel_src) {
                if let Ok(sel) = serde_json::from_str::<selection::LibrarySelection>(&raw) {
                    if selection::write_library_selection(data_dir, &account_id, &sel).is_ok() {
                        selections_imported += 1;
                        touched = true;
                    }
                }
            }
        }

        for bg in [
            "theme-bg.jpg",
            "theme-bg.jpeg",
            "theme-bg.png",
            "theme-bg.webp",
            "theme-bg.gif",
        ] {
            let src = info_dir.join(bg);
            if !src.is_file() {
                continue;
            }
            let ext = Path::new(bg)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");
            let dest = user_state::theme_bg_path_for_ext(data_dir, &account_id, ext);
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = user_state::delete_theme_bg(data_dir, &account_id);
            if fs::copy(&src, &dest).is_ok() {
                touched = true;
            }
            break;
        }

        if touched {
            accounts_synced += 1;
        }
    }

    Ok((
        accounts_synced,
        moods_imported,
        favorites_linked,
        playlists_imported,
        playlist_tracks_linked,
        selections_imported,
        registry_n,
    ))
}

/// One-shot: merge studio metadata from sidecars + `.kord/rekord.db`, and
/// re-import personal data (moods, excludes, settings, favorites, playlists, selection)
/// from `.kord/{account}_info/user-state.json`.
pub fn sync_legacy_library_data(
    db: &Db,
    data_dir: &Path,
    music_root: &Path,
) -> Result<LegacySyncReport> {
    let (album_meta_merged, track_meta_merged) = sync_restored_library_metadata(db, music_root)?;
    // After import: drop stubs reintroduced by bad sidecars (e.g. genre "e").
    let _ = db.clear_weak_studio_placeholders();

    let (
        accounts_moods_synced,
        moods_imported,
        favorites_linked,
        playlists_imported,
        playlist_tracks_linked,
        selections_imported,
        accounts_registry,
    ) = import_legacy_accounts_personal_data(db, data_dir, music_root)?;

    info!(
        album_meta_merged,
        track_meta_merged,
        accounts_moods_synced,
        moods_imported,
        favorites_linked,
        playlists_imported,
        playlist_tracks_linked,
        selections_imported,
        accounts_registry,
        "legacy library sync finished"
    );
    Ok(LegacySyncReport {
        album_meta_merged,
        track_meta_merged,
        accounts_moods_synced,
        moods_imported,
        favorites_linked,
        playlists_imported,
        playlist_tracks_linked,
        selections_imported,
        accounts_registry,
    })
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
            let dest = state.config.lock().unwrap().default_youtube_cookies_path();
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
            "theme-bg.jpg" | "theme-bg.jpeg" | "theme-bg.png" | "theme-bg.webp"
            | "theme-bg.gif" => {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_theme_zip_payload(zip_bytes: &[u8]) -> Result<Option<serde_json::Value>> {
        let mut archive = match ZipArchive::new(Cursor::new(zip_bytes.to_vec())) {
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
        Ok(Some(payload))
    }

    fn build_legacy_theme_zip() -> Vec<u8> {
        let payload = json!({
            "kind": "rekord-theme",
            "version": 1,
            "theme": "custom",
            "glassSurfaces": true,
            "glassOpacity": 100,
            "customTheme": {
                "bg": "#181818",
                "section": "#181818",
                "accent": "#8b5cf6",
                "accent2": "#c4b5fd",
                "bgImageFit": "contain",
                "bgMode": "image"
            },
            "backgroundFile": "background.jpg"
        });
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            add_bytes(
                &mut zip,
                "rekord-theme/rekord-theme.json",
                serde_json::to_string_pretty(&payload).unwrap().as_bytes(),
            )
            .unwrap();
            add_bytes(&mut zip, "rekord-theme/background.jpg", b"fake-jpeg").unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn detects_legacy_theme_zip_without_manifest() {
        let bytes = build_legacy_theme_zip();
        let parsed = parse_theme_zip_payload(&bytes).unwrap().expect("theme zip");
        assert_eq!(parsed["kind"], "rekord-theme");
        assert_eq!(parsed["theme"], "custom");
        assert_eq!(parsed["customTheme"]["accent"], "#8b5cf6");
        assert_eq!(parsed["backgroundFile"], "background.jpg");
    }

    #[test]
    fn restore_remaps_accounts_by_matching_name() {
        let existing = vec![
            Account {
                id: "default".into(),
                name: "Locale".into(),
            },
            Account {
                id: "hub-diego".into(),
                name: "Diego".into(),
            },
        ];
        let backup = vec![
            Account {
                id: "default".into(),
                name: "Default".into(),
            },
            Account {
                id: "bak-diego".into(),
                name: "diego".into(), // case-insensitive
            },
            Account {
                id: "bak-new".into(),
                name: "Nuovo".into(),
            },
        ];
        let (reg, map) = resolve_restore_account_targets(&backup, &existing);
        assert_eq!(map.get("default").map(String::as_str), Some("default"));
        assert_eq!(map.get("bak-diego").map(String::as_str), Some("hub-diego"));
        assert_eq!(map.get("bak-new").map(String::as_str), Some("bak-new"));
        assert_eq!(reg.len(), 3);
        assert!(reg.iter().any(|a| a.id == "hub-diego" && a.name == "diego"));
        assert!(reg.iter().any(|a| a.id == "bak-new" && a.name == "Nuovo"));
    }

    #[test]
    fn restore_keeps_same_id_without_name_steal() {
        let existing = vec![
            Account {
                id: "default".into(),
                name: "Default".into(),
            },
            Account {
                id: "aaa".into(),
                name: "Diego".into(),
            },
        ];
        let backup = vec![
            Account {
                id: "default".into(),
                name: "Default".into(),
            },
            Account {
                id: "aaa".into(),
                name: "Diego".into(),
            },
        ];
        let (_reg, map) = resolve_restore_account_targets(&backup, &existing);
        assert_eq!(map.get("aaa").map(String::as_str), Some("aaa"));
    }

    #[test]
    fn non_theme_zip_returns_none() {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            add_bytes(&mut zip, "readme.txt", b"hi").unwrap();
            zip.finish().unwrap();
        }
        let bytes = cursor.into_inner();
        assert!(parse_theme_zip_payload(&bytes).unwrap().is_none());
    }

    #[test]
    fn real_legacy_theme_fixture_if_present() {
        let path = PathBuf::from("/home/diego-ubuntu/Scaricati/rekord-theme-custom-2026-07-09.zip");
        if !path.is_file() {
            return;
        }
        let bytes = fs::read(&path).unwrap();
        let parsed = parse_theme_zip_payload(&bytes)
            .unwrap()
            .expect("fixture theme zip");
        assert_eq!(parsed["kind"], "rekord-theme");
        assert_eq!(parsed["theme"], "custom");
        // Must not require config/manifest.json — detection is theme-only.
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(read_zip_string(&mut archive, "config/manifest.json")
            .unwrap()
            .is_none());
    }

    #[test]
    fn imports_sidecar_and_legacy_db_metadata_after_scan_shape() {
        let tmp = tempfile_dir();
        let music = tmp.join("music");
        let album_dir = music.join("Artist").join("Album");
        fs::create_dir_all(&album_dir).unwrap();
        fs::write(
            album_dir.join("kord-albuminfo.json"),
            r#"{"title":"Nice Title","genre":"Rock","label":"Label X","releaseDate":"2001"}"#,
        )
        .unwrap();
        fs::write(
            album_dir.join("kord-trackinfo.json"),
            r#"{"01 - Song.mp3":{"title":"Song","source":"deezer","url":"https://example/t/1","genre":"Rock"}}"#,
        )
        .unwrap();

        let hub_db_path = tmp.join("hub.db");
        let db = Db::open(&hub_db_path).unwrap();
        let artist_id = db.upsert_artist("Artist").unwrap();
        let album_id = db
            .upsert_album(
                "Album",
                "Artist",
                Some(artist_id),
                "Artist/Album",
                None,
                false,
            )
            .unwrap();
        db.upsert_track(
            "Artist/Album/01 - Song.mp3",
            &album_dir.join("01 - Song.mp3"),
            "01 - Song",
            "Artist",
            "Album",
            1000,
            Some(1),
            Some(album_id),
            Some(artist_id),
            10,
            0,
            None,
            None,
            None,
        )
        .unwrap();

        let (a1, t1) = import_sidecar_metadata(&db, &music).unwrap();
        assert!(a1 >= 1);
        assert!(t1 >= 1);

        // Build a mini legacy rekord.db with richer track meta for another album path.
        let legacy_dir = music.join(".kord");
        fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_path = legacy_dir.join("rekord.db");
        {
            let leg = Connection::open(&legacy_path).unwrap();
            leg.execute_batch(
                r#"
                CREATE TABLE albums (
                  id TEXT PRIMARY KEY,
                  artist_id TEXT,
                  folder_rel_path TEXT NOT NULL UNIQUE,
                  name TEXT NOT NULL,
                  title TEXT,
                  release_date TEXT,
                  genre TEXT,
                  label TEXT,
                  country TEXT,
                  musicbrainz_release_id TEXT,
                  expected_track_count INTEGER,
                  has_album_meta INTEGER NOT NULL DEFAULT 0,
                  discogs_release_id INTEGER
                );
                CREATE TABLE tracks (
                  id TEXT PRIMARY KEY,
                  rel_path TEXT NOT NULL UNIQUE,
                  album_id TEXT,
                  title TEXT NOT NULL,
                  artist_name TEXT,
                  album_name TEXT,
                  genre TEXT,
                  release_date TEXT,
                  lyrics TEXT,
                  source TEXT,
                  url TEXT
                );
                INSERT INTO albums(id, artist_id, folder_rel_path, name, title, genre, label, has_album_meta)
                VALUES ('A','Artist','Artist/Album','Album','Nice Title','Metal','Legacy Label',1);
                INSERT INTO tracks(id, rel_path, album_id, title, artist_name, album_name, source, url, lyrics)
                VALUES ('T','Artist/Album/01 - Song.mp3','A','Song','Artist','Album','musicbrainz','https://mb/1','la la');
                "#,
            )
            .unwrap();
        }

        // Clear sidecar-filled genre so legacy DB can demonstrate fill-empty merge of lyrics/source.
        {
            let conn = Connection::open(&hub_db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET source=NULL, url=NULL, lyrics=NULL, genre=NULL",
                [],
            )
            .unwrap();
            conn.execute("UPDATE albums SET genre=NULL, label=NULL", [])
                .unwrap();
        }
        let db2 = Db::open(&hub_db_path).unwrap();
        let (a2, t2) = import_legacy_library_db_metadata(&db2, &legacy_path).unwrap();
        assert!(a2 >= 1);
        assert!(t2 >= 1);

        let album = db2
            .list_albums()
            .unwrap()
            .into_iter()
            .find(|a| a.folder_key == "Artist/Album")
            .expect("album");
        assert_eq!(album.genre.as_deref(), Some("Metal"));
        assert_eq!(album.label.as_deref(), Some("Legacy Label"));

        let tracks = db2.tracks_by_album_folder("Artist/Album").unwrap();
        let tr = tracks
            .iter()
            .find(|t| t.rel_path.ends_with("Song.mp3"))
            .unwrap();
        // source/url/lyrics live in DB columns; list API Track may omit some — query sqlite.
        let conn = Connection::open(&hub_db_path).unwrap();
        let (source, url, lyrics): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT source, url, lyrics FROM tracks WHERE rel_path = ?1",
                ["Artist/Album/01 - Song.mp3"],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(source.as_deref(), Some("musicbrainz"));
        assert_eq!(url.as_deref(), Some("https://mb/1"));
        assert_eq!(lyrics.as_deref(), Some("la la"));
        let _ = tr;
    }

    #[test]
    fn real_legacy_backup_db_merges_when_fixture_present() {
        let zip = PathBuf::from(
            "/home/diego-ubuntu/Scaricati/rekord-backup-2026-07-29T14-25-06.354Z.zip",
        );
        if !zip.is_file() {
            return;
        }
        let tmp = tempfile_dir();
        let hub_db_path = tmp.join("hub.db");
        let legacy_path = tmp.join("rekord.db");
        // Extract only legacy DB from the real ZIP.
        {
            let bytes = fs::read(&zip).unwrap();
            let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut f = archive.by_name("kord-db/rekord.db").unwrap();
            let mut out = File::create(&legacy_path).unwrap();
            std::io::copy(&mut f, &mut out).unwrap();
        }
        let db = Db::open(&hub_db_path).unwrap();
        // Seed a few albums/tracks that exist in the fixture DB.
        let samples: Vec<(String, String)> = {
            let leg = Connection::open_with_flags(&legacy_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
            let mut stmt = leg
                .prepare(
                    r#"
                    SELECT a.folder_rel_path, t.rel_path
                    FROM tracks t
                    JOIN albums a ON a.id = t.album_id
                    WHERE t.source IS NOT NULL AND trim(t.source) != ''
                    LIMIT 5
                    "#,
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        };
        assert!(!samples.is_empty());
        for (folder, rel) in &samples {
            let folder = folder.replace('\\', "/");
            let rel = rel.replace('\\', "/");
            let artist = folder.split('/').next().unwrap_or("A");
            let album = folder.split('/').nth(1).unwrap_or("B");
            let artist_id = db.upsert_artist(artist).unwrap();
            let album_id = db
                .upsert_album(album, artist, Some(artist_id), &folder, None, false)
                .unwrap();
            db.upsert_track(
                &rel,
                &Path::new("/tmp").join(&rel),
                "t",
                artist,
                album,
                1,
                None,
                Some(album_id),
                Some(artist_id),
                1,
                0,
                None,
                None,
                None,
            )
            .unwrap();
        }
        let (albums, tracks) = import_legacy_library_db_metadata(&db, &legacy_path).unwrap();
        assert!(albums > 0, "expected album meta from fixture db");
        assert!(tracks > 0, "expected track meta from fixture db");
        let conn = Connection::open(&hub_db_path).unwrap();
        let with_source: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE source IS NOT NULL AND trim(source) != ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(with_source > 0);
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rekord-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
