//! `podcast_sources` rows (schema v6): configuration plus the cached
//! metadata of each source's latest episodes.

use super::net::Validators;
use super::{Episode, PodcastError};
use crate::db::Db;
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// RSS / Atom feed (also found behind a web page).
    Rss,
    /// play.rtl.it programme archive (JSON API).
    Rtl,
    /// A page yt-dlp lists (`--flat-playlist`).
    Ytdlp,
    /// Live radio stream (single "LIVE" item).
    Live,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rss => "rss",
            Self::Rtl => "rtl",
            Self::Ytdlp => "ytdlp",
            Self::Live => "live",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "rss" => Self::Rss,
            "rtl" => Self::Rtl,
            "ytdlp" => Self::Ytdlp,
            "live" => Self::Live,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Source {
    pub id: i64,
    /// What the admin typed.
    pub url: String,
    pub name: String,
    /// The name was typed by a person: feed titles never replace it.
    pub name_custom: bool,
    pub kind: SourceKind,
    /// Resolved address: feed, stream, `rtl:<broadcaster>/<slug>` or the page.
    pub feed_url: String,
    pub episode_count: u32,
    pub position: i64,
    pub artwork_url: Option<String>,
    pub created_at: String,
    pub fetched_at: Option<i64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_error: Option<String>,
    pub error_at: Option<i64>,
    pub episodes: Vec<Episode>,
}

const COLUMNS: &str = "id, url, name, name_custom, kind, feed_url, episode_count, position, \
     artwork_url, created_at, fetched_at, etag, last_modified, last_error, error_at, episodes_json";

fn from_row(r: &Row<'_>) -> rusqlite::Result<Source> {
    let kind: String = r.get(4)?;
    let episodes_json: String = r.get(15)?;
    Ok(Source {
        id: r.get(0)?,
        url: r.get(1)?,
        name: r.get(2)?,
        name_custom: r.get::<_, i64>(3)? != 0,
        kind: SourceKind::parse(&kind).unwrap_or(SourceKind::Rss),
        feed_url: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        episode_count: r
            .get::<_, i64>(6)?
            .clamp(1, i64::from(super::MAX_EPISODE_COUNT)) as u32,
        position: r.get(7)?,
        artwork_url: r.get(8)?,
        created_at: r.get(9)?,
        fetched_at: r.get(10)?,
        etag: r.get(11)?,
        last_modified: r.get(12)?,
        last_error: r.get(13)?,
        error_at: r.get(14)?,
        episodes: serde_json::from_str(&episodes_json).unwrap_or_default(),
    })
}

fn db_err(e: impl std::fmt::Display) -> PodcastError {
    PodcastError::Db(e.to_string())
}

pub fn list(db: &Db) -> Result<Vec<Source>, PodcastError> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {COLUMNS} FROM podcast_sources ORDER BY position, id"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .map_err(db_err)
}

pub fn get(db: &Db, id: i64) -> Result<Option<Source>, PodcastError> {
    db.with_conn(|c| {
        Ok(c.query_row(
            &format!("SELECT {COLUMNS} FROM podcast_sources WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
    })
    .map_err(db_err)
}

pub fn count(db: &Db) -> Result<usize, PodcastError> {
    db.with_conn(|c| {
        Ok(
            c.query_row("SELECT COUNT(*) FROM podcast_sources", [], |r| {
                r.get::<_, i64>(0)
            })? as usize,
        )
    })
    .map_err(db_err)
}

pub struct NewSource<'a> {
    pub url: &'a str,
    pub name: &'a str,
    pub name_custom: bool,
    pub kind: SourceKind,
    pub feed_url: &'a str,
    pub episode_count: u32,
    pub artwork_url: Option<&'a str>,
    /// Episodes the detection already fetched (saved as a fresh cache).
    pub episodes: &'a [Episode],
    pub validators: &'a Validators,
    pub fetched_at: Option<i64>,
}

pub fn insert(db: &Db, s: &NewSource<'_>) -> Result<i64, PodcastError> {
    let episodes = serde_json::to_string(s.episodes).map_err(db_err)?;
    db.with_conn(|c| {
        let next_pos: i64 = c.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM podcast_sources",
            [],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO podcast_sources
               (url, name, name_custom, kind, feed_url, episode_count, position, artwork_url,
                fetched_at, etag, last_modified, episodes_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                s.url,
                s.name,
                s.name_custom as i64,
                s.kind.as_str(),
                s.feed_url,
                s.episode_count,
                next_pos,
                s.artwork_url,
                s.fetched_at,
                s.validators.etag,
                s.validators.last_modified,
                episodes,
            ],
        )?;
        Ok(c.last_insert_rowid())
    })
    .map_err(db_err)
}

/// Name / episode count edits. A new count invalidates the cache.
pub fn update_settings(
    db: &Db,
    id: i64,
    name: Option<(&str, bool)>,
    episode_count: Option<u32>,
) -> Result<bool, PodcastError> {
    db.with_conn(|c| {
        let mut changed = 0;
        if let Some((name, custom)) = name {
            changed += c.execute(
                "UPDATE podcast_sources SET name = ?2, name_custom = ?3 WHERE id = ?1",
                params![id, name, custom as i64],
            )?;
        }
        if let Some(n) = episode_count {
            changed += c.execute(
                "UPDATE podcast_sources
                    SET episode_count = ?2, fetched_at = NULL, etag = NULL, last_modified = NULL
                  WHERE id = ?1 AND episode_count != ?2",
                params![id, n],
            )?;
        }
        Ok(changed > 0)
    })
    .map_err(db_err)
}

/// A new address for a source (re-detected by the caller).
pub fn replace_target(db: &Db, id: i64, s: &NewSource<'_>) -> Result<(), PodcastError> {
    let episodes = serde_json::to_string(s.episodes).map_err(db_err)?;
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources
                SET url = ?2, kind = ?3, feed_url = ?4, artwork_url = ?5, fetched_at = ?6,
                    etag = ?7, last_modified = ?8, episodes_json = ?9,
                    last_error = NULL, error_at = NULL
              WHERE id = ?1",
            params![
                id,
                s.url,
                s.kind.as_str(),
                s.feed_url,
                s.artwork_url,
                s.fetched_at,
                s.validators.etag,
                s.validators.last_modified,
                episodes,
            ],
        )?;
        Ok(())
    })
    .map_err(db_err)
}

/// A source found a better way to be fetched (a yt-dlp page whose feed is
/// now known): same address for the admin, new kind and feed URL.
pub fn retarget(db: &Db, id: i64, kind: SourceKind, feed_url: &str) -> Result<(), PodcastError> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources
                SET kind = ?2, feed_url = ?3, etag = NULL, last_modified = NULL
              WHERE id = ?1",
            params![id, kind.as_str(), feed_url],
        )?;
        Ok(())
    })
    .map_err(db_err)
}

pub fn delete(db: &Db, id: i64) -> Result<bool, PodcastError> {
    db.with_conn(|c| Ok(c.execute("DELETE FROM podcast_sources WHERE id = ?1", [id])? > 0))
        .map_err(db_err)
}

/// New order: `ids` first, in that order; sources not listed keep theirs after.
pub fn reorder(db: &Db, ids: &[i64]) -> Result<(), PodcastError> {
    db.with_conn(|c| {
        let tx = c.unchecked_transaction()?;
        let mut all: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM podcast_sources ORDER BY position, id")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut ordered: Vec<i64> = ids.iter().copied().filter(|id| all.contains(id)).collect();
        ordered.dedup();
        all.retain(|id| !ordered.contains(id));
        ordered.extend(all);
        for (pos, id) in ordered.iter().enumerate() {
            tx.execute(
                "UPDATE podcast_sources SET position = ?2 WHERE id = ?1",
                params![id, pos as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .map_err(db_err)
}

pub struct FetchSave<'a> {
    pub title: Option<&'a str>,
    pub artwork_url: Option<&'a str>,
    pub episodes: &'a [Episode],
    pub validators: &'a Validators,
    pub at: i64,
}

pub fn save_fetch(db: &Db, id: i64, f: &FetchSave<'_>) -> Result<(), PodcastError> {
    let episodes = serde_json::to_string(f.episodes).map_err(db_err)?;
    // Same bound as a name typed in the admin panel.
    let title: Option<String> = f
        .title
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(120).collect());
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources
                SET episodes_json = ?2, fetched_at = ?3, etag = ?4, last_modified = ?5,
                    last_error = NULL, error_at = NULL,
                    artwork_url = COALESCE(?6, artwork_url),
                    name = CASE WHEN name_custom = 0 AND ?7 IS NOT NULL THEN ?7 ELSE name END
              WHERE id = ?1",
            params![
                id,
                episodes,
                f.at,
                f.validators.etag,
                f.validators.last_modified,
                f.artwork_url,
                title,
            ],
        )?;
        Ok(())
    })
    .map_err(db_err)
}

/// Forget the validators and the fetch time: the next request fetches again.
pub fn invalidate(db: &Db, id: i64) -> Result<(), PodcastError> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources SET fetched_at = NULL, etag = NULL, last_modified = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    })
    .map_err(db_err)
}

/// 304: the cached episodes are still current.
pub fn touch(db: &Db, id: i64, at: i64) -> Result<(), PodcastError> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources SET fetched_at = ?2, last_error = NULL, error_at = NULL WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    })
    .map_err(db_err)
}

/// Failed fetch: keep the old episodes (still shown), remember the code.
pub fn save_error(db: &Db, id: i64, code: &str, at: i64) -> Result<(), PodcastError> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE podcast_sources SET last_error = ?2, error_at = ?3 WHERE id = ?1",
            params![id, code, at],
        )?;
        Ok(())
    })
    .map_err(db_err)
}
