//! Per-account library selection vs global FS catalog.
//! Persisted under `data_dir/accounts/{id}/library-selection.json`.

use crate::accounts::{self, DEFAULT_ACCOUNT_ID};
use crate::db::{Album, Artist, Track};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub const SELECTION_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibrarySelection {
    pub version: u32,
    pub include_all: bool,
    pub artists: Vec<String>,
    pub albums: Vec<String>,
    pub tracks: Vec<String>,
}

impl Default for LibrarySelection {
    fn default() -> Self {
        Self {
            version: SELECTION_VERSION,
            include_all: false,
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionPatch {
    pub include_all: Option<bool>,
    pub add_artists: Option<Vec<String>>,
    pub remove_artists: Option<Vec<String>>,
    pub add_albums: Option<Vec<String>>,
    pub remove_albums: Option<Vec<String>>,
    pub add_tracks: Option<Vec<String>>,
    pub remove_tracks: Option<Vec<String>>,
}

/// `"all"` | `"empty"` | `"filter"`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionFilterMode {
    All,
    Empty,
    Filter,
}

pub fn sanitize_rel_path_for_selection(rel_path: &str) -> Option<String> {
    let normalized = rel_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    for seg in normalized.split('/') {
        if seg == ".." || seg == "." || seg.is_empty() {
            return None;
        }
    }
    Some(normalized)
}

fn uniq_strings(arr: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for v in arr {
        let t = v.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    out
}

pub fn sanitize_library_selection(input: &LibrarySelection) -> LibrarySelection {
    LibrarySelection {
        version: SELECTION_VERSION,
        include_all: input.include_all,
        artists: uniq_strings(input.artists.iter().cloned()).into_iter().take(100_000).collect(),
        albums: uniq_strings(input.albums.iter().cloned())
            .into_iter()
            .filter_map(|a| sanitize_rel_path_for_selection(&a))
            .take(200_000)
            .collect(),
        tracks: uniq_strings(input.tracks.iter().cloned())
            .into_iter()
            .filter_map(|t| sanitize_rel_path_for_selection(&t))
            .take(500_000)
            .collect(),
    }
}

pub fn selection_path(data_dir: &Path, account_id: &str) -> std::path::PathBuf {
    accounts::account_library_selection_path(data_dir, account_id).unwrap_or_else(|| {
        data_dir
            .join("accounts")
            .join(DEFAULT_ACCOUNT_ID)
            .join("library-selection.json")
    })
}

/// Legacy global path (pre multi-account). Migrated by `accounts::ensure_accounts`.
pub fn legacy_global_selection_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("library-selection.json")
}

pub fn read_library_selection(data_dir: &Path, account_id: &str) -> Result<LibrarySelection> {
    let _ = accounts::ensure_accounts(data_dir)?;
    let path = selection_path(data_dir, account_id);
    if !path.exists() {
        // Parity with old: missing file → includeAll for default, empty for others.
        if account_id == DEFAULT_ACCOUNT_ID {
            return Ok(LibrarySelection {
                version: SELECTION_VERSION,
                include_all: true,
                artists: Vec::new(),
                albums: Vec::new(),
                tracks: Vec::new(),
            });
        }
        return Ok(LibrarySelection::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: LibrarySelection = serde_json::from_str(&raw).unwrap_or_default();
    Ok(sanitize_library_selection(&parsed))
}

pub fn write_library_selection(
    data_dir: &Path,
    account_id: &str,
    data: &LibrarySelection,
) -> Result<LibrarySelection> {
    let _ = accounts::ensure_accounts(data_dir)?;
    let sanitized = sanitize_library_selection(data);
    let path = selection_path(data_dir, account_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&sanitized)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body)?;
    fs::rename(&tmp, &path)?;
    Ok(sanitized)
}

pub fn get_selection_filter_mode(selection: &LibrarySelection) -> SelectionFilterMode {
    if selection.include_all {
        return SelectionFilterMode::All;
    }
    let has = !selection.artists.is_empty()
        || !selection.albums.is_empty()
        || !selection.tracks.is_empty();
    if has {
        SelectionFilterMode::Filter
    } else {
        SelectionFilterMode::Empty
    }
}

/// Catalog keys available for validating patch add operations.
pub struct CatalogKeys {
    pub artist_names: HashSet<String>,
    pub album_folder_keys: HashSet<String>,
    /// folder_key → artist name
    pub album_artist: std::collections::HashMap<String, String>,
    /// artist name → folder_keys
    pub artist_albums: std::collections::HashMap<String, Vec<String>>,
}

impl CatalogKeys {
    pub fn from_albums_and_artists(artists: &[Artist], albums: &[Album]) -> Self {
        let artist_names: HashSet<String> = artists.iter().map(|a| a.name.clone()).collect();
        let mut album_folder_keys = HashSet::new();
        let mut album_artist = std::collections::HashMap::new();
        let mut artist_albums: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for al in albums {
            album_folder_keys.insert(al.folder_key.clone());
            album_artist.insert(al.folder_key.clone(), al.artist_name.clone());
            artist_albums
                .entry(al.artist_name.clone())
                .or_default()
                .push(al.folder_key.clone());
        }
        Self {
            artist_names,
            album_folder_keys,
            album_artist,
            artist_albums,
        }
    }
}

/// Apply removeAlbums: drop album; if artist was fully selected, demote to
/// remaining albums (parity with old `removeAlbumsFromSelectionSets`).
pub fn remove_albums_from_selection_sets(
    keys: &CatalogKeys,
    artists: &mut HashSet<String>,
    albums: &mut HashSet<String>,
    remove_raw: &[String],
) {
    for raw in remove_raw {
        let Some(rel) = sanitize_rel_path_for_selection(raw) else {
            continue;
        };
        albums.remove(&rel);
        let Some(aid) = keys.album_artist.get(&rel).cloned() else {
            continue;
        };
        if aid.is_empty() || !artists.contains(&aid) {
            continue;
        }
        artists.remove(&aid);
        if let Some(others) = keys.artist_albums.get(&aid) {
            for orp in others {
                if orp == &rel {
                    continue;
                }
                if keys.album_folder_keys.contains(orp) {
                    albums.insert(orp.clone());
                }
            }
        }
    }
}

pub fn merge_selection_patch(
    cur: &LibrarySelection,
    patch: &SelectionPatch,
    keys: &CatalogKeys,
) -> LibrarySelection {
    let mut cur = sanitize_library_selection(cur);

    if patch.include_all == Some(true) {
        return sanitize_library_selection(&LibrarySelection {
            version: SELECTION_VERSION,
            include_all: true,
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
        });
    } else if patch.include_all == Some(false) {
        cur.include_all = false;
    }

    if cur.include_all {
        return cur;
    }

    let mut artists: HashSet<String> = cur.artists.iter().cloned().collect();
    let mut albums: HashSet<String> = cur.albums.iter().cloned().collect();
    let mut tracks: HashSet<String> = cur.tracks.iter().cloned().collect();

    if let Some(add) = &patch.add_artists {
        for a in add {
            let id = a.trim();
            if !id.is_empty() && keys.artist_names.contains(id) {
                artists.insert(id.to_string());
            }
        }
    }
    if let Some(rem) = &patch.remove_artists {
        for a in rem {
            let id = a.trim();
            if !id.is_empty() {
                artists.remove(id);
            }
        }
    }
    if let Some(add) = &patch.add_albums {
        for raw in add {
            if let Some(rel) = sanitize_rel_path_for_selection(raw) {
                if keys.album_folder_keys.contains(&rel) {
                    albums.insert(rel);
                }
            }
        }
    }
    if let Some(rem) = &patch.remove_albums {
        remove_albums_from_selection_sets(keys, &mut artists, &mut albums, rem);
    }
    if let Some(add) = &patch.add_tracks {
        for raw in add {
            if let Some(rel) = sanitize_rel_path_for_selection(raw) {
                tracks.insert(rel);
            }
        }
    }
    if let Some(rem) = &patch.remove_tracks {
        for raw in rem {
            if let Some(rel) = sanitize_rel_path_for_selection(raw) {
                tracks.remove(&rel);
            }
        }
    }

    sanitize_library_selection(&LibrarySelection {
        version: SELECTION_VERSION,
        include_all: false,
        artists: artists.into_iter().collect(),
        albums: albums.into_iter().collect(),
        tracks: tracks.into_iter().collect(),
    })
}

pub fn filter_albums(albums: Vec<Album>, sel: &LibrarySelection) -> Vec<Album> {
    match get_selection_filter_mode(sel) {
        SelectionFilterMode::All => albums,
        SelectionFilterMode::Empty => Vec::new(),
        SelectionFilterMode::Filter => {
            let artist_set: HashSet<&str> = sel.artists.iter().map(|s| s.as_str()).collect();
            let album_set: HashSet<&str> = sel.albums.iter().map(|s| s.as_str()).collect();
            albums
                .into_iter()
                .filter(|a| album_set.contains(a.folder_key.as_str()) || artist_set.contains(a.artist_name.as_str()))
                .collect()
        }
    }
}

pub fn filter_tracks(tracks: Vec<Track>, albums: &[Album], sel: &LibrarySelection) -> Vec<Track> {
    match get_selection_filter_mode(sel) {
        SelectionFilterMode::All => tracks,
        SelectionFilterMode::Empty => Vec::new(),
        SelectionFilterMode::Filter => {
            let album_ids: HashSet<i64> = albums.iter().map(|a| a.id).collect();
            let track_set: HashSet<&str> = sel.tracks.iter().map(|s| s.as_str()).collect();
            tracks
                .into_iter()
                .filter(|t| {
                    track_set.contains(t.rel_path.as_str())
                        || t.album_id
                            .map(|id| album_ids.contains(&id))
                            .unwrap_or(false)
                })
                .collect()
        }
    }
}

pub fn filter_artists(artists: Vec<Artist>, albums: &[Album], tracks: &[Track], sel: &LibrarySelection) -> Vec<Artist> {
    match get_selection_filter_mode(sel) {
        SelectionFilterMode::All => artists,
        SelectionFilterMode::Empty => Vec::new(),
        SelectionFilterMode::Filter => {
            let artist_set: HashSet<&str> = sel.artists.iter().map(|s| s.as_str()).collect();
            let album_artist_names: HashSet<&str> =
                albums.iter().map(|a| a.artist_name.as_str()).collect();
            let track_artist_names: HashSet<&str> =
                tracks.iter().map(|t| t.artist_name.as_str()).collect();
            artists
                .into_iter()
                .filter(|a| {
                    artist_set.contains(a.name.as_str())
                        || album_artist_names.contains(a.name.as_str())
                        || track_artist_names.contains(a.name.as_str())
                })
                .map(|mut a| {
                    // Recount from filtered albums/tracks for accurate UI badges.
                    let ac = albums.iter().filter(|al| al.artist_name == a.name).count() as i64;
                    let tc = tracks.iter().filter(|t| t.artist_name == a.name).count() as i64;
                    a.album_count = ac;
                    a.track_count = tc;
                    a
                })
                .filter(|a| a.album_count > 0 || a.track_count > 0)
                .collect()
        }
    }
}
