use crate::cover::find_cover_in_dir;
use crate::db::Db;
use anyhow::{bail, Context, Result};
use lofty::file::AudioFile;
use lofty::prelude::*;
use lofty::probe::Probe;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::{info, warn};

const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "aiff", "aif", "alac",
];

const EXCLUDE_DIRS: &[&str] = &[
    ".rekord", ".kord", ".wpp", "@eaDir", "#recycle", ".Trash", "node_modules",
];

const LOOSE_ALBUM: &str = "Tracks";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanReport {
    pub scanned_files: u64,
    pub indexed_tracks: u64,
    pub skipped: u64,
    pub errors: u64,
    pub music_root: String,
}

pub fn scan_library(db: &Db, music_root: &Path) -> Result<ScanReport> {
    if !music_root.is_dir() {
        bail!("music root is not a directory: {}", music_root.display());
    }

    let root = music_root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", music_root.display()))?;

    let preserved = db.snapshot_user_links()?;
    db.clear_catalog()?;

    let mut scanned_files = 0u64;
    let mut indexed_tracks = 0u64;
    let mut skipped = 0u64;
    let mut errors = 0u64;

    for artist_entry in fs::read_dir(&root)?.flatten() {
        let artist_path = artist_entry.path();
        if !artist_path.is_dir() {
            continue;
        }
        let artist_name = match artist_path.file_name().and_then(|n| n.to_str()) {
            Some(n) if !is_excluded_dir(n) => n.to_string(),
            _ => continue,
        };

        match index_artist(db, &root, &artist_path, &artist_name) {
            Ok(stats) => {
                scanned_files += stats.scanned;
                indexed_tracks += stats.indexed;
                skipped += stats.skipped;
                errors += stats.errors;
            }
            Err(err) => {
                errors += 1;
                warn!(artist = %artist_name, error = %err, "artist index failed");
            }
        }
    }

    db.rebuild_fts()?;
    db.refresh_counts()?;
    db.restore_user_links(&preserved)?;

    let now = chrono::Utc::now().to_rfc3339();
    db.set_meta("last_scan_at", &now)?;
    db.set_meta("music_root", &root.to_string_lossy())?;
    db.set_meta("schema_scan", "folder-first-v2")?;

    info!(
        scanned_files,
        indexed_tracks, skipped, errors, "library scan complete (folder-first)"
    );

    Ok(ScanReport {
        scanned_files,
        indexed_tracks,
        skipped,
        errors,
        music_root: root.to_string_lossy().into_owned(),
    })
}

struct ArtistStats {
    scanned: u64,
    indexed: u64,
    skipped: u64,
    errors: u64,
}

fn index_artist(
    db: &Db,
    root: &Path,
    artist_path: &Path,
    artist_name: &str,
) -> Result<ArtistStats> {
    let mut stats = ArtistStats {
        scanned: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
    };

    let artist_id = db.upsert_artist(artist_name)?;
    let mut loose_files: Vec<PathBuf> = Vec::new();

    for entry in fs::read_dir(artist_path)?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Some(album_folder) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if is_excluded_dir(album_folder) {
                continue;
            }
            match index_album_folder(
                db,
                root,
                artist_id,
                artist_name,
                album_folder,
                &path,
                false,
            ) {
                Ok(s) => {
                    stats.scanned += s.scanned;
                    stats.indexed += s.indexed;
                    stats.skipped += s.skipped;
                    stats.errors += s.errors;
                }
                Err(err) => {
                    stats.errors += 1;
                    warn!(album = %album_folder, error = %err, "album index failed");
                }
            }
        } else if path.is_file() && is_audio(&path) {
            loose_files.push(path);
        }
    }

    if !loose_files.is_empty() {
        let folder_key = format!("{artist_name}/{LOOSE_ALBUM}");
        let album_id = db.upsert_album(
            LOOSE_ALBUM,
            artist_name,
            Some(artist_id),
            &folder_key,
            None,
            true,
        )?;
        for path in loose_files {
            stats.scanned += 1;
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("track");
            let rel = format!("{artist_name}/{LOOSE_ALBUM}/{file_name}");
            match index_audio_file(
                db,
                &path,
                &rel,
                artist_id,
                album_id,
                artist_name,
                LOOSE_ALBUM,
            ) {
                Ok(true) => stats.indexed += 1,
                Ok(false) => stats.skipped += 1,
                Err(err) => {
                    stats.errors += 1;
                    warn!(path = %path.display(), error = %err, "loose track failed");
                }
            }
        }
    }

    Ok(stats)
}

fn index_album_folder(
    db: &Db,
    _root: &Path,
    artist_id: i64,
    artist_name: &str,
    album_folder: &str,
    album_path: &Path,
    loose: bool,
) -> Result<ArtistStats> {
    let mut stats = ArtistStats {
        scanned: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
    };

    let folder_key = format!("{artist_name}/{album_folder}");
    let cover = find_cover_in_dir(album_path);
    let album_id = db.upsert_album(
        album_folder,
        artist_name,
        Some(artist_id),
        &folder_key,
        cover.as_deref(),
        loose,
    )?;

    for entry in fs::read_dir(album_path)?.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_audio(&path) {
            continue;
        }
        stats.scanned += 1;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("track");
        let rel = format!("{folder_key}/{file_name}");
        match index_audio_file(
            db,
            &path,
            &rel,
            artist_id,
            album_id,
            artist_name,
            album_folder,
        ) {
            Ok(true) => stats.indexed += 1,
            Ok(false) => stats.skipped += 1,
            Err(err) => {
                stats.errors += 1;
                warn!(path = %path.display(), error = %err, "track index failed");
            }
        }
    }

    Ok(stats)
}

fn index_audio_file(
    db: &Db,
    path: &Path,
    rel: &str,
    artist_id: i64,
    album_id: i64,
    artist_name: &str,
    album_name: &str,
) -> Result<bool> {
    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let (title, track_number, duration_ms) = read_audio_meta(path, &file_stem);

    db.upsert_track(
        rel,
        path,
        &title,
        artist_name,
        album_name,
        duration_ms,
        track_number,
        Some(album_id),
        Some(artist_id),
        size,
        mtime,
    )?;
    Ok(true)
}

fn read_audio_meta(path: &Path, fallback_title: &str) -> (String, Option<i64>, i64) {
    let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) else {
        return (fallback_title.to_string(), None, 0);
    };
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let duration_ms = tagged.properties().duration().as_millis() as i64;
    let title = tag
        .and_then(|t| t.title().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    let track_number = tag.and_then(|t| t.track()).map(|n| n as i64);
    (title, track_number, duration_ms)
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_excluded_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.') || EXCLUDE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&lower))
}
