//! Genre tokens: every `genre` string is split into tokens (`text::split_genres`)
//! and each token is shown with one canonical label per normalised key, so
//! "Hip Hop", "Hip-hop" and "Hip-Hop" are one genre.
//!
//! The labels live in the `genres` table (rebuilt after scans and imports);
//! `tracks.genres` / `albums.genres` hold the labels of each row as a JSON
//! array, which is what the API serves as `genres`.

use super::text::{canonical_genre_labels, genre_key, split_genres};
use super::Db;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

/// One canonical genre with how much of the library carries it.
#[derive(Debug, Clone, Serialize)]
pub struct GenreCount {
    pub key: String,
    pub label: String,
    pub track_count: i64,
    pub album_count: i64,
    pub artist_count: i64,
}

/// Tokens of a genre string, each through the Studio canonical label table
/// (`metadata::genres`: "hip-hop" → "Hip Hop", "rnb" → "R&B") so the library
/// and Studio agree on spellings.
fn tokens(raw: Option<&str>) -> Vec<String> {
    split_genres(raw.unwrap_or(""))
        .iter()
        .map(|t| crate::metadata::genres::canonical_genre_label(t))
        .collect()
}

pub(super) fn parse_genres_json(raw: Option<&str>) -> Vec<String> {
    raw.filter(|s| !s.trim().is_empty())
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default()
}

fn labels_for(raw: Option<&str>, labels: &HashMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in tokens(raw) {
        let label = labels.get(&genre_key(&token)).cloned().unwrap_or(token);
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

fn to_json(labels: &[String]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".into())
}

/// Recompute canonical labels from every track / album genre and rewrite the
/// `genres` columns that changed.
pub(super) fn rebuild_genres(conn: &Connection) -> Result<()> {
    let tracks: Vec<(i64, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, genre, genres FROM tracks")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.flatten().collect()
    };
    let albums: Vec<(i64, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, genre, genres FROM albums")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.flatten().collect()
    };

    let mut spellings: HashMap<String, HashMap<String, u64>> = HashMap::new();
    // Tracks per key, each track once (as the single-edit updates count them).
    let mut track_counts: HashMap<String, i64> = HashMap::new();
    for (_, genre, _) in &tracks {
        let mut keys: Vec<String> = Vec::new();
        for token in tokens(genre.as_deref()) {
            let key = genre_key(&token);
            if !keys.contains(&key) {
                keys.push(key.clone());
            }
            *spellings.entry(key).or_default().entry(token).or_default() += 1;
        }
        for key in keys {
            *track_counts.entry(key).or_default() += 1;
        }
    }
    for (_, genre, _) in &albums {
        for token in tokens(genre.as_deref()) {
            spellings
                .entry(genre_key(&token))
                .or_default()
                .entry(token)
                .or_default();
        }
    }
    let labels = canonical_genre_labels(&spellings);

    {
        let mut upd = conn.prepare("UPDATE tracks SET genres = ?2 WHERE id = ?1")?;
        for (id, genre, current) in &tracks {
            let json = to_json(&labels_for(genre.as_deref(), &labels));
            if current.as_deref() != Some(json.as_str()) {
                upd.execute(params![id, json])?;
            }
        }
    }
    {
        let mut upd = conn.prepare("UPDATE albums SET genres = ?2 WHERE id = ?1")?;
        for (id, genre, current) in &albums {
            let json = to_json(&labels_for(genre.as_deref(), &labels));
            if current.as_deref() != Some(json.as_str()) {
                upd.execute(params![id, json])?;
            }
        }
    }
    conn.execute("DELETE FROM genres", [])?;
    let mut ins =
        conn.prepare("INSERT INTO genres(key, label, track_count) VALUES (?1, ?2, ?3)")?;
    for (key, label) in &labels {
        ins.execute(params![
            key,
            label,
            track_counts.get(key).copied().unwrap_or(0)
        ])?;
    }
    Ok(())
}

/// Known label for a token, registering the token itself when the key is new.
fn label_or_register(conn: &Connection, token: &str) -> Result<String> {
    let key = genre_key(token);
    let label: Option<String> = conn
        .query_row(
            "SELECT label FROM genres WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    match label {
        Some(l) => Ok(l),
        None => {
            conn.execute(
                "INSERT OR IGNORE INTO genres(key, label, track_count) VALUES (?1, ?2, 0)",
                params![key, token],
            )?;
            Ok(token.to_string())
        }
    }
}

/// Keep `genres.track_count` (what `library/stats` counts as `genre_count`)
/// in step with one track whose labels went from `old` to `new`, without a
/// full rebuild: each key counts the tracks carrying it.
fn adjust_track_counts(conn: &Connection, old: &[String], new: &[String]) -> Result<()> {
    let keys = |labels: &[String]| {
        let mut out: Vec<String> = Vec::new();
        for l in labels {
            let k = genre_key(l);
            if !out.contains(&k) {
                out.push(k);
            }
        }
        out
    };
    let (old, new) = (keys(old), keys(new));
    let mut upd = conn.prepare_cached(
        "UPDATE genres SET track_count = MAX(0, track_count + ?2) WHERE key = ?1",
    )?;
    for k in old.iter().filter(|k| !new.contains(k)) {
        upd.execute(params![k, -1])?;
    }
    for k in new.iter().filter(|k| !old.contains(k)) {
        upd.execute(params![k, 1])?;
    }
    Ok(())
}

/// Tracks about to be deleted (rows matching `filter`, one `?1` parameter):
/// their genres no longer count.
pub(super) fn forget_track_genres(
    conn: &Connection,
    filter: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<()> {
    let rows: Vec<Option<String>> = {
        let mut stmt = conn.prepare(&format!("SELECT genres FROM tracks WHERE {filter}"))?;
        let rows = stmt.query_map(params![value], |r| r.get(0))?;
        rows.flatten().collect()
    };
    for current in rows {
        adjust_track_counts(conn, &parse_genres_json(current.as_deref()), &[])?;
    }
    Ok(())
}

/// Recompute `genres` for the rows of `table` matching `filter` (a SQL
/// condition with one `?1` parameter) after a single edit.
pub(super) fn refresh_genres_where(
    conn: &Connection,
    table: &str,
    filter: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<()> {
    let rows: Vec<(i64, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, genre, genres FROM {table} WHERE {filter}"
        ))?;
        let rows = stmt.query_map(params![value], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.flatten().collect()
    };
    for (id, genre, current) in rows {
        let mut labels: Vec<String> = Vec::new();
        for token in tokens(genre.as_deref()) {
            let label = label_or_register(conn, &token)?;
            if !labels.contains(&label) {
                labels.push(label);
            }
        }
        let json = to_json(&labels);
        if current.as_deref() != Some(json.as_str()) {
            conn.execute(
                &format!("UPDATE {table} SET genres = ?2 WHERE id = ?1"),
                params![id, json],
            )?;
            if table == "tracks" {
                adjust_track_counts(conn, &parse_genres_json(current.as_deref()), &labels)?;
            }
        }
    }
    Ok(())
}

impl Db {
    /// Rebuild canonical genre labels and every row's `genres`.
    pub fn rebuild_genres(&self) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        rebuild_genres(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Normalised key → canonical label.
    pub fn genre_labels(&self) -> Result<HashMap<String, String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT key, label FROM genres")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.flatten().collect())
    }
}

/// Counts per canonical genre over a set of tracks (`(genres, album_id,
/// artist_id)`), most common first.
pub fn count_genres<'a>(
    tracks: impl IntoIterator<Item = (&'a [String], Option<i64>, Option<i64>)>,
) -> Vec<GenreCount> {
    use std::collections::HashSet;
    struct Acc {
        label: String,
        tracks: i64,
        albums: HashSet<i64>,
        artists: HashSet<i64>,
    }
    let mut by_key: HashMap<String, Acc> = HashMap::new();
    for (genres, album_id, artist_id) in tracks {
        for label in genres {
            let acc = by_key.entry(genre_key(label)).or_insert_with(|| Acc {
                label: label.clone(),
                tracks: 0,
                albums: HashSet::new(),
                artists: HashSet::new(),
            });
            acc.tracks += 1;
            if let Some(id) = album_id {
                acc.albums.insert(id);
            }
            if let Some(id) = artist_id {
                acc.artists.insert(id);
            }
        }
    }
    let mut out: Vec<GenreCount> = by_key
        .into_iter()
        .map(|(key, a)| GenreCount {
            key,
            label: a.label,
            track_count: a.tracks,
            album_count: a.albums.len() as i64,
            artist_count: a.artists.len() as i64,
        })
        .collect();
    out.sort_by(|a, b| {
        b.track_count
            .cmp(&a.track_count)
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    out
}
