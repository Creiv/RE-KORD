//! External metadata providers + album/track/artwork apply.

pub mod artwork;
pub mod providers;

use crate::config::AppConfig;
use crate::db::Db;
use crate::path_util::{join_under_root, safe_rel_path, under_root};
use anyhow::{bail, Result};
use providers::{
    discogs_apply_release, discogs_search_releases, fetch_album_meta, fetch_track_lyrics_lrclib,
    fetch_track_meta, DiscogsReleaseCandidate, FetchedAlbumMeta, FetchedTrackMeta,
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
        if let Some(uri) = &meta.discogs_uri {
            obj.insert("discogsUri".into(), json!(uri));
        }
        if let Some(extra) = &meta.discogs_extra {
            if let Ok(v) = serde_json::to_value(extra) {
                obj.insert("discogsExtra".into(), v);
            }
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
        .or_else(|| album_path.split('/').next().map(|s| s.to_string()))
        .unwrap_or_default();
    let album_name = album
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| album_path.rsplit('/').next().map(|s| s.to_string()))
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
        discogs_uri: None,
        discogs_extra: None,
        discogs_extra_json: None,
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
    let album = if parts.len() >= 3 { parts[1] } else { "" };
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

/// Fetch synced/plain lyrics from LRCLIB (does not auto-save).
pub async fn track_lyrics_fetch(music_root: &Path, db: &Db, rel_path: &str) -> Result<Value> {
    let rel = safe_rel_path(rel_path)?;
    let abs = join_under_root(music_root, &rel)?;
    if !abs.is_file() || !under_root(&abs, music_root) {
        bail!("track not found");
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let artist_folder = parts.first().copied().unwrap_or("");
    let album_folder = if parts.len() >= 3 { parts[1] } else { "" };
    let track = db.track_by_rel(&rel)?;
    let artist = track
        .as_ref()
        .map(|t| t.artist_name.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(artist_folder);
    let title = track
        .as_ref()
        .map(|t| t.title.clone())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            abs.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("track")
                .to_string()
        });
    let duration_ms = track.as_ref().map(|t| t.duration_ms).filter(|d| *d > 0);
    let (synced, plain) =
        fetch_track_lyrics_lrclib(artist, &title, album_folder, duration_ms).await?;
    Ok(json!({
        "relPath": rel,
        "syncedLyrics": synced,
        "plainLyrics": plain,
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

const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "webm",
];

const ALBUM_ORDERING_KEYS: &[&str] = &[
    "expectedTrackCount",
    "expectedTracks",
    "tracklist",
    "discogsTracklist",
];

const TRACK_ORDERING_KEYS: &[&str] = &["trackNumber", "discNumber", "position", "track"];

fn is_audio_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn is_junk_parens(inner: &str) -> bool {
    let t = inner.trim();
    if t.is_empty() {
        return false;
    }
    // Keep feat./ft./with collaborations.
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("feat")
        || lower.starts_with("ft.")
        || lower.starts_with("ft ")
        || lower.starts_with("with ")
        || lower.starts_with("featuring")
    {
        return false;
    }
    const PATS: &[&str] = &[
        "official",
        "music video",
        "lyric",
        "lyrics",
        "audio",
        "video",
        "visualizer",
        "remaster",
        "remix",
        "radio edit",
        "extended",
        "original mix",
        "topic",
        "4k",
        "1080p",
        "720p",
        "explicit",
        "deluxe",
        "vevo",
        "spotify",
        "youtube",
        "clip",
        "trailer",
        "teaser",
        "hd",
        "hq",
        "live",
        "karaoke",
        "instrumental",
        "mono",
        "stereo",
    ];
    PATS.iter().any(|p| lower.contains(p))
}

fn strip_junk_parens(mut s: String) -> String {
    for _ in 0..15 {
        let before = s.clone();
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        let mut changed = false;
        while let Some(c) = chars.next() {
            if c == '(' || c == '（' {
                let mut inner = String::new();
                let mut closed = false;
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == ')' || n == '）' {
                        closed = true;
                        break;
                    }
                    inner.push(n);
                }
                if closed && is_junk_parens(&inner) {
                    changed = true;
                    out.push(' ');
                } else if closed {
                    out.push('(');
                    out.push_str(&inner);
                    out.push(')');
                } else {
                    out.push(c);
                    out.push_str(&inner);
                }
            } else {
                out.push(c);
            }
        }
        s = out.split_whitespace().collect::<Vec<_>>().join(" ");
        if !changed || s == before {
            break;
        }
    }
    s
}

fn artist_name_variants(artist: &str) -> Vec<String> {
    let a = artist.trim();
    if a.len() < 2 {
        return vec![];
    }
    let mut out = vec![a.to_string()];
    if a.to_ascii_lowercase().starts_with("the ") {
        out.push(a[4..].trim().to_string());
    } else {
        out.push(format!("The {a}"));
    }
    out.into_iter().filter(|x| x.len() >= 2).collect()
}

/// Parity with legacy `sanitizeLocalTrackTitleDisplay`.
pub fn sanitize_local_track_title_display(
    raw: &str,
    artist_folder: Option<&str>,
    track_artist: Option<&str>,
) -> String {
    let mut cleaned = String::new();
    let mut depth = 0i32;
    for c in raw.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => cleaned.push(c),
            _ => {}
        }
    }
    let mut s = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    // Leading track numbers: "01 - Title" / "01. Title"
    {
        let bytes = s.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > 0 {
            let rest = s[i..].trim_start();
            if let Some(first) = rest.chars().next() {
                if matches!(first, '-' | '–' | '—' | '.') {
                    s = rest
                        .trim_start_matches(['-', '–', '—', '.', ' '])
                        .trim()
                        .to_string();
                }
            }
        }
    }

    s = strip_junk_parens(s);
    for _ in 0..4 {
        let before = s.clone();
        let lower = s.to_ascii_lowercase();
        if lower.ends_with("- topic") {
            s = s[..s.len().saturating_sub("- topic".len())]
                .trim()
                .to_string();
        }
        if s == before {
            break;
        }
    }

    let ar = track_artist
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .or_else(|| artist_folder.map(str::trim).filter(|x| !x.is_empty()))
        .unwrap_or("");
    for v in artist_name_variants(ar) {
        let lower = s.to_ascii_lowercase();
        let pv = v.to_ascii_lowercase();
        let mut stripped = false;
        for sep in [" - ", " – ", " — ", " | "] {
            let needle = format!("{pv}{sep}");
            if lower.starts_with(&needle) {
                s = s[v.len() + sep.len()..].trim().to_string();
                stripped = true;
                break;
            }
        }
        if stripped {
            break;
        }
        for sep in [" - ", " – ", " — "] {
            let needle = format!("{sep}{pv}");
            if lower.ends_with(&needle) {
                let keep = s.len().saturating_sub(needle.len());
                let left = s[..keep].trim();
                if !left.is_empty() {
                    s = left.to_string();
                    stripped = true;
                }
                break;
            }
        }
        if stripped {
            break;
        }
    }

    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.len() > 200 {
        s.truncate(200);
    }
    s
}

/// Preview/apply sanitized titles for one album or the whole library.
pub async fn sanitize_track_titles(
    music_root: &Path,
    db: &Db,
    scope: &str,
    album_path: Option<&str>,
    dry_run: bool,
) -> Result<Value> {
    let mut changes = Vec::new();
    let albums: Vec<String> = if scope == "all" {
        db.list_albums()?
            .into_iter()
            .filter(|a| !a.loose)
            .map(|a| a.folder_key)
            .filter(|k| !k.is_empty())
            .collect()
    } else {
        let p = album_path.unwrap_or("").trim();
        if p.is_empty() {
            bail!("albumPath is required for album scope");
        }
        vec![safe_rel_path(p)?]
    };

    for album_rel in &albums {
        let dir = match album_dir(music_root, album_rel) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let artist_folder = album_rel.split('/').next().unwrap_or("");
        let sidecar_path = dir.join(FILE_TRACK);
        let sidecar = read_json(&sidecar_path);
        for entry in fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if !is_audio_file(&fname) {
                continue;
            }
            let base = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&fname)
                .to_string();
            let track_artist = sidecar
                .get(&fname)
                .and_then(|v| v.get("artist"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let to = sanitize_local_track_title_display(
                &base,
                Some(artist_folder),
                track_artist.as_deref(),
            );
            if to == base || to.is_empty() {
                continue;
            }
            let rel = format!("{album_rel}/{fname}");
            changes.push(json!({
                "albumRel": album_rel,
                "albumPath": album_rel,
                "fileName": fname,
                "from": base,
                "to": to,
            }));
            if !dry_run {
                let patch = TrackMetaPatch {
                    title: Some(to),
                    ..Default::default()
                };
                let _ = track_info_save(music_root, db, &rel, patch).await;
            }
        }
    }

    Ok(json!({
        "changes": changes,
        "albumsScanned": albums.len(),
        "dryRun": dry_run,
        "written": !dry_run && !changes.is_empty(),
        "albumPath": album_path.unwrap_or(""),
    }))
}

/// Remove orphan keys from `kord-trackinfo.json` and clear ordering fields (legacy prune).
pub fn prune_album_library_metadata(music_root: &Path, album_path: &str) -> Result<Value> {
    let dir = album_dir(music_root, album_path)?;
    let mut audio_names = std::collections::HashSet::new();
    for entry in fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if is_audio_file(name) {
                    audio_names.insert(name.to_string());
                }
            }
        }
    }

    let track_path = dir.join(FILE_TRACK);
    let mut orphan_removed: Vec<String> = Vec::new();
    let mut track_ordering_cleared = 0u32;
    let mut json_files_trimmed = 0u32;
    if track_path.is_file() {
        let mut j = read_json(&track_path);
        if let Some(obj) = j.as_object_mut() {
            let keys: Vec<String> = obj.keys().cloned().collect();
            for k in keys {
                if !audio_names.contains(&k) {
                    obj.remove(&k);
                    orphan_removed.push(k);
                }
            }
            for (_k, row) in obj.iter_mut() {
                if let Some(r) = row.as_object_mut() {
                    let mut touched = false;
                    for ok in TRACK_ORDERING_KEYS {
                        if r.remove(*ok).is_some() {
                            touched = true;
                        }
                    }
                    if touched {
                        track_ordering_cleared += 1;
                    }
                }
            }
            if !orphan_removed.is_empty() || track_ordering_cleared > 0 {
                write_json(&track_path, &j)?;
                json_files_trimmed += 1;
            }
        }
    }

    let album_meta_path = dir.join(FILE_ALBUM);
    let mut expected_tracks_cleared = false;
    if album_meta_path.is_file() {
        let mut j = read_json(&album_meta_path);
        if let Some(obj) = j.as_object_mut() {
            for k in ALBUM_ORDERING_KEYS {
                if obj.remove(*k).is_some() {
                    expected_tracks_cleared = true;
                }
            }
            if expected_tracks_cleared {
                write_json(&album_meta_path, &j)?;
            }
        }
    }

    let written = !orphan_removed.is_empty()
        || expected_tracks_cleared
        || track_ordering_cleared > 0
        || json_files_trimmed > 0;

    Ok(json!({
        "albumPath": safe_rel_path(album_path)?,
        "removed": orphan_removed,
        "written": written,
        "expectedTracksCleared": expected_tracks_cleared,
        "trackOrderingFieldsCleared": track_ordering_cleared,
        "albumFieldsMerged": 0,
        "tracksMerged": 0,
        "jsonFilesRemoved": 0,
        "jsonFilesTrimmed": json_files_trimmed,
    }))
}
