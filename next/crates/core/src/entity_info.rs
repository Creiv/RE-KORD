//! Read-only entity info / curiosità from library folders
//! (`kord-artistinfo.json`, album `infoItems` in `kord-albuminfo.json`).

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const FILE_ARTIST_INFO: &str = "kord-artistinfo.json";
const FILE_ALBUM: &str = "kord-albuminfo.json";
const FILE_ALBUM_WPP: &str = "wpp-albuminfo.json";
const MAX_ITEMS: usize = 40;
const ITEM_TEXT_MAX: usize = 6000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityInfoItem {
    pub id: String,
    pub lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    #[serde(rename = "savedAt", skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntityInfoBundle {
    pub items: Vec<EntityInfoItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

fn safe_seg(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..") {
        bail!("invalid path segment");
    }
    Ok(s.to_string())
}

fn under_root(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(&r),
        _ => false,
    }
}

fn resolve_dirs(
    root: &Path,
    artist: &str,
    album: Option<&str>,
) -> Result<(PathBuf, Option<PathBuf>)> {
    let artist_seg = safe_seg(artist)?;
    let artist_dir = root.join(&artist_seg);
    if !artist_dir.is_dir() || !under_root(&artist_dir, root) {
        bail!("artist not found");
    }
    let Some(album_raw) = album.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok((artist_dir, None));
    };
    let album_seg = safe_seg(album_raw)?;
    let album_dir = artist_dir.join(&album_seg);
    if !album_dir.is_dir() || !under_root(&album_dir, root) {
        bail!("album not found");
    }
    Ok((artist_dir, Some(album_dir)))
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn sanitize_item(raw: &Value) -> Option<EntityInfoItem> {
    let obj = raw.as_object()?;
    let text = obj
        .get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(ITEM_TEXT_MAX).collect::<String>())
        .filter(|s| !s.is_empty())?;
    let lang = obj
        .get("lang")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(8).collect())
        .unwrap_or_else(|| "it".into());
    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(64).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let title = obj
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(200).collect::<String>())
        .filter(|s| !s.is_empty());
    let saved_at = obj
        .get("savedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(EntityInfoItem {
        id,
        lang,
        title,
        text,
        saved_at,
    })
}

fn sanitize_items_list(raw: Option<&Value>) -> Vec<EntityInfoItem> {
    let Some(arr) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in arr {
        let Some(item) = sanitize_item(row) else {
            continue;
        };
        if !seen.insert(item.id.clone()) {
            continue;
        }
        out.push(item);
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    out
}

fn items_from_legacy(j: &Value) -> Vec<EntityInfoItem> {
    j.get("info").and_then(sanitize_item).into_iter().collect()
}

pub fn load_artist_info_bundle(artist_dir: &Path) -> EntityInfoBundle {
    let j = read_json(&artist_dir.join(FILE_ARTIST_INFO));
    let mut items = j
        .as_ref()
        .map(|v| {
            let mut list = sanitize_items_list(v.get("items"));
            list.extend(items_from_legacy(v));
            list
        })
        .unwrap_or_default();
    items.truncate(MAX_ITEMS);
    let image = j
        .as_ref()
        .and_then(|v| v.get("image"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('/') && !s.contains('\\'))
        .map(|s| s.to_string());
    EntityInfoBundle { items, image }
}

fn pick_album_meta_path(album_dir: &Path) -> PathBuf {
    let k = album_dir.join(FILE_ALBUM);
    let w = album_dir.join(FILE_ALBUM_WPP);
    if k.is_file() {
        k
    } else if w.is_file() {
        w
    } else {
        k
    }
}

pub fn load_album_info_items(album_dir: &Path) -> Vec<EntityInfoItem> {
    let Some(j) = read_json(&pick_album_meta_path(album_dir)) else {
        return vec![];
    };
    let mut items = sanitize_items_list(j.get("infoItems"));
    items.extend(items_from_legacy(&j));
    items.truncate(MAX_ITEMS);
    items
}

pub fn get_entity_info(
    music_root: &Path,
    artist: &str,
    album: Option<&str>,
) -> Result<EntityInfoBundle> {
    let (artist_dir, album_dir) = resolve_dirs(music_root, artist, album)?;
    if let Some(album_dir) = album_dir {
        return Ok(EntityInfoBundle {
            items: load_album_info_items(&album_dir),
            image: None,
        });
    }
    Ok(load_artist_info_bundle(&artist_dir))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityInfoSaveRequest {
    pub artist: String,
    pub album: Option<String>,
    #[serde(default)]
    pub add: Vec<Value>,
    #[serde(default)]
    pub remove_ids: Vec<String>,
    pub image_url: Option<String>,
}

pub fn save_entity_info(music_root: &Path, req: EntityInfoSaveRequest) -> Result<EntityInfoBundle> {
    let (artist_dir, album_dir_opt) = resolve_dirs(music_root, &req.artist, req.album.as_deref())?;
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(album_dir) = album_dir_opt {
        let path = pick_album_meta_path(&album_dir);
        let mut j = read_json(&path).unwrap_or_else(|| serde_json::json!({}));
        let mut items = sanitize_items_list(j.get("infoItems"));
        let remove: HashSet<_> = req.remove_ids.iter().cloned().collect();
        items.retain(|it| !remove.contains(&it.id));
        for raw in &req.add {
            if let Some(mut item) = sanitize_item(raw) {
                if item.saved_at.is_none() {
                    item.saved_at = Some(now.clone());
                }
                if items.iter().any(|x| x.id == item.id) {
                    continue;
                }
                items.push(item);
            }
        }
        items.truncate(MAX_ITEMS);
        if let Some(obj) = j.as_object_mut() {
            obj.insert(
                "infoItems".into(),
                serde_json::to_value(&items).unwrap_or_default(),
            );
        }
        fs::write(&path, serde_json::to_string_pretty(&j)?)?;
        return Ok(EntityInfoBundle { items, image: None });
    }

    let path = artist_dir.join(FILE_ARTIST_INFO);
    let mut j = read_json(&path).unwrap_or_else(|| serde_json::json!({}));
    let mut bundle = load_artist_info_bundle(&artist_dir);
    let remove: HashSet<_> = req.remove_ids.iter().cloned().collect();
    bundle.items.retain(|it| !remove.contains(&it.id));
    for raw in &req.add {
        if let Some(mut item) = sanitize_item(raw) {
            if item.saved_at.is_none() {
                item.saved_at = Some(now.clone());
            }
            if bundle.items.iter().any(|x| x.id == item.id) {
                continue;
            }
            bundle.items.push(item);
        }
    }
    bundle.items.truncate(MAX_ITEMS);

    // image_url is applied by the API layer (async download) via set_artist_image_bytes.

    if let Some(obj) = j.as_object_mut() {
        obj.insert(
            "items".into(),
            serde_json::to_value(&bundle.items).unwrap_or_default(),
        );
        if let Some(img) = &bundle.image {
            obj.insert("image".into(), Value::String(img.clone()));
        }
    } else {
        j = serde_json::json!({
            "items": bundle.items,
            "image": bundle.image,
        });
    }
    fs::write(&path, serde_json::to_string_pretty(&j)?)?;
    Ok(bundle)
}

/// Async-friendly: write artist image bytes.
pub fn set_artist_image_bytes(artist_dir: &Path, bytes: &[u8]) -> Result<String> {
    let name = "kord-artistinfo.jpg";
    fs::write(artist_dir.join(name), bytes)?;
    // Update sidecar image field.
    let path = artist_dir.join(FILE_ARTIST_INFO);
    let mut j = read_json(&path).unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = j.as_object_mut() {
        obj.insert("image".into(), Value::String(name.into()));
    }
    fs::write(&path, serde_json::to_string_pretty(&j)?)?;
    Ok(name.into())
}

pub fn resolve_artist_dir(music_root: &Path, artist: &str) -> Result<PathBuf> {
    let (artist_dir, _) = resolve_dirs(music_root, artist, None)?;
    Ok(artist_dir)
}
