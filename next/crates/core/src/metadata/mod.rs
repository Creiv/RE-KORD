//! External metadata providers + album/track/artwork apply.

pub mod artwork;
pub mod providers;

use crate::config::AppConfig;
use crate::db::Db;
use crate::path_util::{join_under_root, safe_rel_path, under_root};
use anyhow::{bail, Result};
use providers::{
    discogs_apply_release, discogs_search_releases, fetch_album_meta, fetch_track_meta,
    DiscogsReleaseCandidate, FetchedAlbumMeta, FetchedTrackMeta,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const FILE_ALBUM: &str = "kord-albuminfo.json";
const FILE_TRACK: &str = "kord-trackinfo.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetaPatch {
    pub title: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub label: Option<String>,
    pub country: Option<String>,
    pub musicbrainz_release_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetaPatch {
    pub title: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub lyrics: Option<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub source: Option<String>,
    pub url: Option<String>,
}

fn album_dir(music_root: &Path, album_path: &str) -> Result<PathBuf> {
    let rel = safe_rel_path(album_path)?;
    if rel.is_empty() {
        bail!("album path required");
    }
    let abs = join_under_root(music_root, &rel)?;
    if !abs.is_dir() || !under_root(&abs, music_root) {
        bail!("album not found");
    }
    Ok(abs)
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_json(path: &Path, v: &Value) -> Result<()> {
    fs::write(path, serde_json::to_string_pretty(v)?)?;
    Ok(())
}

fn merge_album_sidecar(dir: &Path, meta: &FetchedAlbumMeta) -> Result<Value> {
    let path = dir.join(FILE_ALBUM);
    let mut j = read_json(&path);
    if let Some(obj) = j.as_object_mut() {
        if let Some(t) = &meta.title {
            obj.insert("title".into(), json!(t));
        }
        if let Some(d) = &meta.release_date {
            obj.insert("releaseDate".into(), json!(d));
        }
        if let Some(g) = &meta.genre {
            obj.insert("genre".into(), json!(g));
        }
        if let Some(l) = &meta.label {
            obj.insert("label".into(), json!(l));
        }
        if let Some(c) = &meta.country {
            obj.insert("country".into(), json!(c));
        }
        if let Some(id) = &meta.musicbrainz_release_id {
            obj.insert("musicbrainzReleaseId".into(), json!(id));
        }
        if let Some(id) = &meta.discogs_release_id {
            obj.insert("discogsReleaseId".into(), json!(id));
        }
        if let Some(src) = &meta.source {
            obj.insert("source".into(), json!(src));
        }
        obj.insert("fetchedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
    }
    write_json(&path, &j)?;
    Ok(j)
}

fn merge_track_sidecar(album_dir: &Path, filename: &str, meta: &FetchedTrackMeta) -> Result<()> {
    let path = album_dir.join(FILE_TRACK);
    let mut j = read_json(&path);
    if !j.is_object() {
        j = json!({});
    }
    let entry = json!({
        "title": meta.title,
        "releaseDate": meta.release_date,
        "genre": meta.genre,
        "lyrics": meta.lyrics,
        "trackNumber": meta.track_number,
        "discNumber": meta.disc_number,
        "source": meta.source,
        "url": meta.url,
        "fetchedAt": chrono::Utc::now().to_rfc3339(),
    });
    j.as_object_mut()
        .unwrap()
        .insert(filename.to_string(), entry);
    write_json(&path, &j)
}

pub async fn album_info_fetch(
    cfg: &AppConfig,
    music_root: &Path,
    db: &Db,
    album_path: &str,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<Value> {
    let dir = album_dir(music_root, album_path)?;
    let artist_name = artist
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            album_path
                .split('/')
                .next()
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let album_name = album
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            album_path
                .rsplit('/')
                .next()
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let meta = fetch_album_meta(cfg, &artist_name, &album_name).await?;
    let sidecar = merge_album_sidecar(&dir, &meta)?;
    let _ = db.apply_album_meta(album_path, &meta);
    Ok(json!({
        "ok": true,
        "albumPath": safe_rel_path(album_path)?,
        "meta": meta,
        "album": sidecar,
    }))
}

pub async fn album_info_save(
    music_root: &Path,
    db: &Db,
    album_path: &str,
    patch: AlbumMetaPatch,
) -> Result<Value> {
    let dir = album_dir(music_root, album_path)?;
    let path = dir.join(FILE_ALBUM);
    let mut j = read_json(&path);
    if let Some(obj) = j.as_object_mut() {
        if let Some(t) = &patch.title {
            obj.insert("title".into(), json!(t));
        }
        if let Some(d) = &patch.release_date {
            obj.insert("releaseDate".into(), json!(d));
        }
        if let Some(g) = &patch.genre {
            obj.insert("genre".into(), json!(g));
        }
        if let Some(l) = &patch.label {
            obj.insert("label".into(), json!(l));
        }
        if let Some(c) = &patch.country {
            obj.insert("country".into(), json!(c));
        }
        if let Some(id) = &patch.musicbrainz_release_id {
            obj.insert("musicbrainzReleaseId".into(), json!(id));
        }
    }
    write_json(&path, &j)?;
    let meta = FetchedAlbumMeta {
        ok: true,
        title: patch.title.clone(),
        release_date: patch.release_date.clone(),
        genre: patch.genre.clone(),
        label: patch.label.clone(),
        country: patch.country.clone(),
        source: Some("manual".into()),
        musicbrainz_release_id: patch.musicbrainz_release_id.clone(),
        discogs_release_id: None,
        expected_track_count: None,
    };
    let _ = db.apply_album_meta(album_path, &meta);
    if let Some(g) = &patch.genre {
        let _ = db.set_album_tracks_genre(album_path, g);
    }
    Ok(json!({
        "albumPath": safe_rel_path(album_path)?,
        "meta": meta,
        "album": j,
    }))
}

pub async fn track_info_fetch(
    cfg: &AppConfig,
    music_root: &Path,
    db: &Db,
    rel_path: &str,
) -> Result<Value> {
    let rel = safe_rel_path(rel_path)?;
    let abs = join_under_root(music_root, &rel)?;
    if !abs.is_file() || !under_root(&abs, music_root) {
        bail!("track not found");
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let artist = parts.first().copied().unwrap_or("");
    let album = if parts.len() >= 3 {
        parts[1]
    } else {
        ""
    };
    let title = abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    // Prefer DB title if present.
    let title = db
        .track_by_rel(&rel)?
        .map(|t| t.title)
        .filter(|t| !t.is_empty())
        .unwrap_or(title);
    let meta = fetch_track_meta(cfg, artist, album, &title).await?;
    if let Some(parent) = abs.parent() {
        if let Some(fname) = abs.file_name().and_then(|s| s.to_str()) {
            let _ = merge_track_sidecar(parent, fname, &meta);
        }
    }
    let _ = db.apply_track_meta(&rel, &meta);
    Ok(json!({
        "ok": true,
        "relPath": rel,
        "meta": meta,
    }))
}

pub async fn track_info_fetch_album(
    cfg: &AppConfig,
    music_root: &Path,
    db: &Db,
    album_path: &str,
) -> Result<Value> {
    let dir = album_dir(music_root, album_path)?;
    let tracks = db.tracks_by_album_folder(album_path)?;
    let mut fetched = 0u32;
    let mut failed = 0u32;
    let mut out_tracks = Vec::new();
    let mut errors = Vec::new();
    for t in tracks {
        match track_info_fetch(cfg, music_root, db, &t.rel_path).await {
            Ok(v) => {
                fetched += 1;
                out_tracks.push(v);
            }
            Err(e) => {
                failed += 1;
                errors.push(json!({ "relPath": t.rel_path, "error": e.to_string() }));
            }
        }
    }
    // Also scan loose files if DB empty for this album.
    if fetched + failed == 0 {
        for entry in fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                ext.as_str(),
                "mp3" | "flac" | "m4a" | "aac" | "ogg" | "opus" | "wav" | "wma" | "webm"
            ) {
                continue;
            }
            let rel = format!(
                "{}/{}",
                safe_rel_path(album_path)?,
                path.file_name().unwrap().to_string_lossy()
            );
            match track_info_fetch(cfg, music_root, db, &rel).await {
                Ok(v) => {
                    fetched += 1;
                    out_tracks.push(v);
                }
                Err(e) => {
                    failed += 1;
                    errors.push(json!({ "relPath": rel, "error": e.to_string() }));
                }
            }
        }
    }
    Ok(json!({
        "albumPath": safe_rel_path(album_path)?,
        "fetched": fetched,
        "failed": failed,
        "tracks": out_tracks,
        "errors": errors,
    }))
}

pub async fn track_info_save(
    music_root: &Path,
    db: &Db,
    rel_path: &str,
    patch: TrackMetaPatch,
) -> Result<Value> {
    let rel = safe_rel_path(rel_path)?;
    let abs = join_under_root(music_root, &rel)?;
    if !abs.is_file() || !under_root(&abs, music_root) {
        bail!("track not found");
    }
    let meta = FetchedTrackMeta {
        ok: true,
        title: patch.title.clone(),
        release_date: patch.release_date.clone(),
        genre: patch.genre.clone(),
        lyrics: patch.lyrics.clone(),
        track_number: patch.track_number,
        disc_number: patch.disc_number,
        source: patch.source.clone().or(Some("manual".into())),
        url: patch.url.clone(),
        duration_ms: None,
    };
    if let Some(parent) = abs.parent() {
        if let Some(fname) = abs.file_name().and_then(|s| s.to_str()) {
            merge_track_sidecar(parent, fname, &meta)?;
        }
    }
    db.apply_track_meta(&rel, &meta)?;
    Ok(json!({
        "ok": true,
        "relPath": rel,
        "meta": meta,
    }))
}

pub async fn discogs_search(
    cfg: &AppConfig,
    artist: &str,
    album: &str,
) -> Result<Vec<DiscogsReleaseCandidate>> {
    discogs_search_releases(cfg, artist, album).await
}

pub async fn discogs_apply(
    cfg: &AppConfig,
    music_root: &Path,
    db: &Db,
    album_path: &str,
    release_id: i64,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<Value> {
    let dir = album_dir(music_root, album_path)?;
    let artist_name = artist.unwrap_or("").trim();
    let album_name = album.unwrap_or("").trim();
    let meta = discogs_apply_release(cfg, release_id, artist_name, album_name).await?;
    let sidecar = merge_album_sidecar(&dir, &meta)?;
    db.apply_album_meta(album_path, &meta)?;
    Ok(json!({
        "ok": true,
        "albumPath": safe_rel_path(album_path)?,
        "meta": meta,
        "album": sidecar,
    }))
}

pub use artwork::{apply_artwork_url, search_artwork, upload_artwork, ArtworkHit};
