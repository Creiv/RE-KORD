use crate::cover::find_cover_in_dir;
use crate::db::Db;
use crate::layout::{self, is_audio_name, is_excluded_dir, LibraryLayout, LOOSE_ALBUM_FOLDER};
use anyhow::{bail, Context, Result};
use lofty::file::AudioFile;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::{info, warn};

const LOOSE_ALBUM: &str = LOOSE_ALBUM_FOLDER;
/// Guard against pathological trees / symlink loops while collecting album files.
const MAX_ALBUM_DEPTH: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// Upsert what is on disk and drop rows whose files disappeared.
    Incremental,
    /// Wipe the catalog first, then rebuild from scratch.
    Full,
}

impl ScanMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Full => "full",
        }
    }

    pub fn from_query(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("full") | Some("rebuild") => Self::Full,
            _ => Self::Incremental,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned_files: u64,
    pub indexed_tracks: u64,
    /// Files whose size+mtime matched the previous scan (tags not re-read).
    pub unchanged: u64,
    pub skipped: u64,
    pub errors: u64,
    pub removed_tracks: u64,
    pub removed_albums: u64,
    pub removed_artists: u64,
    pub mode: String,
    #[serde(rename = "music_root")]
    pub music_root: String,
}

/// Incremental scan (default): safe to run repeatedly, keeps favorites/playlists.
pub fn scan_library(db: &Db, music_root: &Path) -> Result<ScanReport> {
    scan_library_with(db, music_root, ScanMode::Incremental)
}

pub fn scan_library_with(db: &Db, music_root: &Path, mode: ScanMode) -> Result<ScanReport> {
    if !music_root.is_dir() {
        bail!("music root is not a directory: {}", music_root.display());
    }

    let root = music_root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", music_root.display()))?;
    let layout = layout::load_layout(&root);

    // Full rebuild wipes the FS catalog; favorites / playlist membership are
    // re-attached by rel_path afterwards.
    let preserved = if mode == ScanMode::Full {
        let snap = db.snapshot_user_links()?;
        db.clear_catalog()?;
        Some(snap)
    } else {
        None
    };

    let known_files = if mode == ScanMode::Incremental {
        db.file_states()?
    } else {
        Default::default()
    };

    let mut stats = Stats::default();
    let mut seen: HashSet<String> = HashSet::new();

    for group in collect_groups(&root, &layout) {
        if let Err(err) = index_group(db, &group, &known_files, &mut seen, &mut stats) {
            stats.errors += 1;
            warn!(album = %group.folder_key, error = %err, "album index failed");
        }
    }

    let mut removed_tracks = 0u64;
    let mut removed_albums = 0u64;
    let mut removed_artists = 0u64;
    if mode == ScanMode::Incremental {
        removed_tracks = db.prune_tracks_outside(&seen)?;
        removed_albums = db.prune_empty_albums()?;
        removed_artists = db.prune_empty_artists()?;
    }

    db.rebuild_fts()?;
    db.refresh_counts()?;
    if let Some(snap) = preserved {
        db.restore_user_links(&snap)?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    db.set_meta("last_scan_at", &now)?;
    db.set_meta("music_root", &root.to_string_lossy())?;
    db.set_meta("schema_scan", "folder-first-v3")?;
    db.set_meta("last_scan_mode", mode.as_str())?;

    info!(
        scanned_files = stats.scanned,
        indexed_tracks = stats.indexed,
        unchanged = stats.unchanged,
        skipped = stats.skipped,
        errors = stats.errors,
        removed_tracks,
        removed_albums,
        removed_artists,
        mode = mode.as_str(),
        layout = layout.preferred_layout.as_str(),
        "library scan complete"
    );

    Ok(ScanReport {
        scanned_files: stats.scanned,
        indexed_tracks: stats.indexed,
        unchanged: stats.unchanged,
        skipped: stats.skipped,
        errors: stats.errors,
        removed_tracks,
        removed_albums,
        removed_artists,
        mode: mode.as_str().to_string(),
        music_root: root.to_string_lossy().into_owned(),
    })
}

#[derive(Default)]
struct Stats {
    scanned: u64,
    indexed: u64,
    unchanged: u64,
    skipped: u64,
    errors: u64,
}

/// One album worth of files, already resolved to display names.
struct AlbumGroup {
    artist: String,
    album: String,
    /// `<artist>/<album folder>` — stable album key, also the rel_path prefix.
    folder_key: String,
    /// Directory used for cover lookup (None for synthetic groups).
    cover_dir: Option<PathBuf>,
    loose: bool,
    /// (absolute path, rel_path)
    files: Vec<(PathBuf, String)>,
}

fn collect_groups(root: &Path, layout: &LibraryLayout) -> Vec<AlbumGroup> {
    let mut groups: Vec<AlbumGroup> = Vec::new();
    let mut root_loose: Vec<PathBuf> = Vec::new();

    let Ok(entries) = fs::read_dir(root) else {
        return groups;
    };
    let mut top: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    top.sort();

    for path in top {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        if path.is_file() {
            if is_audio_name(name) {
                root_loose.push(path);
            }
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        collect_artist_dir(&path, name, layout, &mut groups);
    }

    if !root_loose.is_empty() {
        // Flat layout: audio directly in the root. Artist comes from tags when the
        // layout allows it, otherwise from the configured virtual artist.
        for file in root_loose {
            let Some(file_name) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let artist = if layout.uses_tags() {
                read_tag_artist(&file).unwrap_or_else(|| layout.virtual_artist.clone())
            } else {
                layout.virtual_artist.clone()
            };
            let folder_key = format!("{artist}/{LOOSE_ALBUM}");
            let rel = format!("{folder_key}/{file_name}");
            match groups.iter_mut().find(|g| g.folder_key == folder_key) {
                Some(existing) => existing.files.push((file, rel)),
                None => groups.push(AlbumGroup {
                    artist: artist.clone(),
                    album: LOOSE_ALBUM.to_string(),
                    folder_key,
                    cover_dir: Some(root.to_path_buf()),
                    loose: true,
                    files: vec![(file, rel)],
                }),
            }
        }
    }

    groups
}

fn collect_artist_dir(
    artist_path: &Path,
    artist_name: &str,
    layout: &LibraryLayout,
    groups: &mut Vec<AlbumGroup>,
) {
    let Ok(entries) = fs::read_dir(artist_path) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    children.sort();

    let mut loose: Vec<(PathBuf, String)> = Vec::new();

    for child in children {
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        if child.is_dir() {
            // Even in `artist/track` libraries subfolders are indexed as albums, so
            // nothing on disk is ever dropped; the artist's own files stay loose.
            collect_album_dir(&child, artist_name, name, layout, groups);
        } else if child.is_file() && is_audio_name(name) {
            let rel = format!("{artist_name}/{LOOSE_ALBUM}/{name}");
            loose.push((child, rel));
        }
    }

    if !loose.is_empty() {
        groups.push(AlbumGroup {
            artist: artist_name.to_string(),
            album: LOOSE_ALBUM.to_string(),
            folder_key: format!("{artist_name}/{LOOSE_ALBUM}"),
            cover_dir: Some(artist_path.to_path_buf()),
            loose: true,
            files: loose,
        });
    }
}

fn collect_album_dir(
    album_path: &Path,
    artist_name: &str,
    album_folder: &str,
    layout: &LibraryLayout,
    groups: &mut Vec<AlbumGroup>,
) {
    let folder_key = format!("{artist_name}/{album_folder}");
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    // Nested folders (CD1/CD2, bonus discs) are part of the same album unless the
    // layout explicitly asks for one album per folder.
    collect_audio_recursive(
        album_path,
        &folder_key,
        0,
        layout.deep_scan,
        &mut files,
        groups,
        artist_name,
    );

    if !files.is_empty() {
        groups.push(AlbumGroup {
            artist: artist_name.to_string(),
            album: album_folder.to_string(),
            folder_key,
            cover_dir: Some(album_path.to_path_buf()),
            loose: false,
            files,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_audio_recursive(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    split_subfolders: bool,
    files: &mut Vec<(PathBuf, String)>,
    groups: &mut Vec<AlbumGroup>,
    artist_name: &str,
) {
    if depth > MAX_ALBUM_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    children.sort();

    for child in children {
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        if child.is_file() {
            if is_audio_name(name) {
                let rel = format!("{rel_prefix}/{name}");
                files.push((child, rel));
            }
            continue;
        }
        if !child.is_dir() {
            continue;
        }
        if split_subfolders {
            let nested_key = format!("{rel_prefix}/{name}");
            let mut nested_files = Vec::new();
            collect_audio_recursive(
                &child,
                &nested_key,
                depth + 1,
                split_subfolders,
                &mut nested_files,
                groups,
                artist_name,
            );
            if !nested_files.is_empty() {
                groups.push(AlbumGroup {
                    artist: artist_name.to_string(),
                    album: name.to_string(),
                    folder_key: nested_key,
                    cover_dir: Some(child.clone()),
                    loose: false,
                    files: nested_files,
                });
            }
        } else {
            collect_audio_recursive(
                &child,
                &format!("{rel_prefix}/{name}"),
                depth + 1,
                split_subfolders,
                files,
                groups,
                artist_name,
            );
        }
    }
}

fn index_group(
    db: &Db,
    group: &AlbumGroup,
    known_files: &std::collections::HashMap<String, (i64, i64)>,
    seen: &mut HashSet<String>,
    stats: &mut Stats,
) -> Result<()> {
    let artist_id = db.upsert_artist(&group.artist)?;
    let cover = group.cover_dir.as_deref().and_then(find_cover_in_dir);
    let album_id = db.upsert_album(
        &group.album,
        &group.artist,
        Some(artist_id),
        &group.folder_key,
        cover.as_deref(),
        group.loose,
    )?;

    let mut touched = false;
    for (path, rel) in &group.files {
        stats.scanned += 1;
        seen.insert(rel.clone());

        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(err) => {
                stats.errors += 1;
                warn!(path = %path.display(), error = %err, "stat failed");
                continue;
            }
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        if let Some((known_size, known_mtime)) = known_files.get(rel) {
            if *known_size == size && *known_mtime == mtime {
                // Unchanged on disk: keep DB row (and any Studio edits) untouched,
                // just make sure it points at the current album/artist rows.
                db.relink_track(rel, album_id, artist_id, &group.artist, &group.album)?;
                stats.unchanged += 1;
                continue;
            }
        }

        match index_audio_file(
            db,
            path,
            rel,
            artist_id,
            album_id,
            &group.artist,
            &group.album,
            size as u64,
            mtime,
        ) {
            Ok(()) => {
                stats.indexed += 1;
                touched = true;
            }
            Err(err) => {
                stats.errors += 1;
                warn!(path = %path.display(), error = %err, "track index failed");
            }
        }
    }

    if touched {
        let _ = db.backfill_album_meta_from_tracks(album_id);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn index_audio_file(
    db: &Db,
    path: &Path,
    rel: &str,
    artist_id: i64,
    album_id: i64,
    artist_name: &str,
    album_name: &str,
    size: u64,
    mtime: i64,
) -> Result<()> {
    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let meta = read_audio_meta(path, &file_stem);

    db.upsert_track(
        rel,
        path,
        &meta.title,
        artist_name,
        album_name,
        meta.duration_ms,
        meta.track_number,
        Some(album_id),
        Some(artist_id),
        size,
        mtime,
        meta.genre.as_deref(),
        meta.release_date.as_deref(),
        meta.lyrics.as_deref(),
    )?;
    Ok(())
}

struct AudioMeta {
    title: String,
    track_number: Option<i64>,
    duration_ms: i64,
    genre: Option<String>,
    release_date: Option<String>,
    lyrics: Option<String>,
}

fn read_tag_artist(path: &Path) -> Option<String> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.artist()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_audio_meta(path: &Path, fallback_title: &str) -> AudioMeta {
    let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) else {
        return AudioMeta {
            title: fallback_title.to_string(),
            track_number: None,
            duration_ms: 0,
            genre: None,
            release_date: None,
            lyrics: None,
        };
    };
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let duration_ms = tagged.properties().duration().as_millis() as i64;
    let title = tag
        .and_then(|t| t.title().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    let track_number = tag.and_then(|t| t.track()).map(|n| n as i64);
    let genre = tag
        .and_then(|t| t.genre().map(|s| s.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let release_date = tag
        .and_then(|t| t.year().map(|y| y.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let lyrics = tag
        .and_then(|t| t.get_string(&ItemKey::Lyrics).map(|s| s.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    AudioMeta {
        title,
        track_number,
        duration_ms,
        genre,
        release_date,
        lyrics,
    }
}
