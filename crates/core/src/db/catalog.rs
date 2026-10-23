//! Filesystem catalog writes: scan upserts (batched in one transaction per
//! album), pruning of vanished files and the parking of user links.
//!
//! Favorites and playlist entries reference `tracks.id` with `ON DELETE
//! CASCADE`. Whenever the *catalog* (not the user) drops a track, its user
//! links are first parked by rel_path; the `tracks_reattach_user_links`
//! trigger puts them back as soon as a track with that rel_path is indexed
//! again (remounted drive, interrupted full rescan, restored backup).

use super::{Db, UserLinkSnapshot};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// One track row as written by the scanner (and the embedded-tags backfill).
///
/// The metadata fields hold what this read of the file found: tag values,
/// with the file / folder name as fallback. [`upsert_track`] merges them with
/// the stored row: curated values (`edited_fields`) and typed ones
/// (`user_fields`) are kept according to `policy`, `embedded_mask` says
/// which of the values came from the tags.
#[derive(Debug, Clone)]
pub struct TrackRow<'a> {
    pub rel_path: &'a str,
    pub file_path: &'a Path,
    pub title: &'a str,
    pub artist_name: &'a str,
    pub album_name: &'a str,
    pub duration_ms: i64,
    pub track_number: Option<i64>,
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub size: u64,
    pub mtime: i64,
    pub genre: Option<&'a str>,
    pub release_date: Option<&'a str>,
    pub lyrics: Option<&'a str>,
    pub bpm: Option<f64>,
    pub disc_number: Option<i64>,
    /// Album title from the file's tags (the album row picks the most common).
    pub tag_album: Option<&'a str>,
    pub tag_artist: Option<&'a str>,
    pub tag_album_artist: Option<&'a str>,
    pub track_total: Option<i64>,
    pub disc_total: Option<i64>,
    pub mb_recording_id: Option<&'a str>,
    pub mb_release_id: Option<&'a str>,
    pub mb_artist_id: Option<&'a str>,
    pub mb_release_group_id: Option<&'a str>,
    /// `db::field` bits of the values above that came from the tags.
    pub embedded_mask: i64,
    /// Version of the tag reader that produced the values; `None` for writes
    /// that did not read the file (they only fill gaps).
    pub tags_version: Option<i64>,
    pub policy: crate::embedded::MergePolicy,
    /// Record size / mtime in `files` (the scan); the backfill leaves them.
    pub write_file_state: bool,
}

/// Catalog writes sharing one transaction; see [`Db::write_batch`].
pub struct CatalogBatch<'a> {
    conn: &'a Connection,
}

impl CatalogBatch<'_> {
    pub(super) fn conn(&self) -> &Connection {
        self.conn
    }

    /// Store (or, with `None`, drop) the synthetic Xing frame `/media`
    /// splices into an MP3 at `insert_at`; valid while size and mtime match.
    pub fn set_mp3_seek_header(
        &self,
        rel_path: &str,
        size: u64,
        mtime: i64,
        header: Option<(u64, &[u8])>,
    ) -> Result<()> {
        match header {
            Some((insert_at, frame)) => self.conn.execute(
                "INSERT INTO mp3_seek_headers(rel_path, size, mtime, insert_at, frame)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(rel_path) DO UPDATE SET size = excluded.size,
                   mtime = excluded.mtime, insert_at = excluded.insert_at,
                   frame = excluded.frame",
                params![rel_path, size as i64, mtime, insert_at as i64, frame],
            )?,
            None => self.conn.execute(
                "DELETE FROM mp3_seek_headers WHERE rel_path = ?1",
                params![rel_path],
            )?,
        };
        Ok(())
    }

    pub fn upsert_artist(&self, name: &str) -> Result<i64> {
        upsert_artist(self.conn, name)
    }

    pub fn upsert_album(
        &self,
        name: &str,
        artist_name: &str,
        artist_id: Option<i64>,
        folder_key: &str,
        cover_path: Option<&Path>,
        loose: bool,
    ) -> Result<i64> {
        upsert_album(
            self.conn,
            name,
            artist_name,
            artist_id,
            folder_key,
            cover_path,
            loose,
        )
    }

    /// Current display title of an album row.
    pub fn album_name(&self, album_id: i64) -> Result<String> {
        Ok(self.conn.query_row(
            "SELECT name FROM albums WHERE id = ?1",
            params![album_id],
            |r| r.get(0),
        )?)
    }

    /// See [`sync_album_display`].
    pub fn sync_album_display(
        &self,
        album_id: i64,
        folder_title: &str,
        use_tags: bool,
    ) -> Result<()> {
        sync_album_display(self.conn, album_id, folder_title, use_tags)
    }

    /// Mark an album as updated (new or changed files).
    pub fn touch_album(&self, album_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE albums SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            params![album_id],
        )?;
        Ok(())
    }

    pub fn upsert_track(&self, row: &TrackRow<'_>) -> Result<i64> {
        upsert_track(self.conn, row)
    }

    pub fn relink_track(
        &self,
        rel_path: &str,
        album_id: i64,
        artist_id: i64,
        artist_name: &str,
        album_name: &str,
    ) -> Result<()> {
        relink_track(
            self.conn,
            rel_path,
            album_id,
            artist_id,
            artist_name,
            album_name,
        )
    }

    pub fn backfill_album_meta_from_tracks(
        &self,
        album_id: i64,
        prefer_embedded: bool,
    ) -> Result<()> {
        backfill_album_meta_from_tracks(self.conn, album_id, prefer_embedded)
    }

    /// Record the cover's origin; `embedded_from`: `Some(None)` = never
    /// checked, `Some(Some(""))` = no picture found, `Some(Some(rel))` = the
    /// track it came from; `None` leaves it as it is.
    pub fn set_album_cover_info(
        &self,
        album_id: i64,
        source: Option<&str>,
        embedded_from: Option<Option<&str>>,
    ) -> Result<()> {
        set_album_cover_info(self.conn, album_id, source, embedded_from)
    }
}

/// Result of [`Db::prune_tracks_outside_guarded`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PruneOutcome {
    /// Tracks indexed before the prune.
    pub indexed: u64,
    /// Indexed tracks whose rel_path was not seen on disk.
    pub missing: u64,
    /// Tracks actually deleted (0 when skipped).
    pub removed: u64,
    /// Why the guard refused to prune, if it did.
    pub skipped: Option<String>,
}

pub(super) fn upsert_artist(conn: &Connection, name: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO artists(name) VALUES (?1) ON CONFLICT(name) DO NOTHING",
        params![name],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM artists WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub(super) fn upsert_album(
    conn: &Connection,
    name: &str,
    artist_name: &str,
    artist_id: Option<i64>,
    folder_key: &str,
    cover_path: Option<&Path>,
    loose: bool,
) -> Result<i64> {
    let cover = cover_path.map(|p| p.to_string_lossy().into_owned());
    let has_cover = cover.is_some();
    let cover_version = cover_path.and_then(cover_version_of);
    // The display title of an existing album is kept: it comes from the tags
    // or a curated value (see `sync_album_display`), not from the folder.
    conn.execute(
        r#"
        INSERT INTO albums(name, artist_name, artist_id, folder_key, cover_path, has_cover, loose, cover_version)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(folder_key) DO UPDATE SET
          artist_name=excluded.artist_name,
          artist_id=COALESCE(excluded.artist_id, albums.artist_id),
          cover_path=excluded.cover_path,
          has_cover=excluded.has_cover,
          loose=excluded.loose,
          cover_version=excluded.cover_version
        "#,
        params![
            name,
            artist_name,
            artist_id,
            folder_key,
            cover,
            has_cover as i64,
            loose as i64,
            cover_version
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM albums WHERE folder_key = ?1",
        params![folder_key],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// What the stored row holds for the merged fields.
#[derive(Debug, Default)]
struct StoredTrack {
    title: Option<String>,
    genre: Option<String>,
    release_date: Option<String>,
    track_number: Option<i64>,
    disc_number: Option<i64>,
    lyrics: Option<String>,
    bpm: Option<f64>,
    tag_album: Option<String>,
    tag_artist: Option<String>,
    tag_album_artist: Option<String>,
    track_total: Option<i64>,
    disc_total: Option<i64>,
    mb: [Option<String>; 4],
    edited: i64,
    user: i64,
    embedded: i64,
    tags_version: i64,
}

fn stored_track(conn: &Connection, rel_path: &str) -> Result<Option<StoredTrack>> {
    Ok(conn
        .query_row(
            r#"
            SELECT title, genre, release_date, track_number, disc_number, lyrics, bpm,
                   tag_album, tag_artist, tag_album_artist, track_total, disc_total,
                   mb_recording_id, mb_release_id, mb_artist_id, mb_release_group_id,
                   edited_fields, user_fields, embedded_fields, tags_version
            FROM tracks WHERE rel_path = ?1
            "#,
            params![rel_path],
            |r| {
                Ok(StoredTrack {
                    title: r.get(0)?,
                    genre: r.get(1)?,
                    release_date: r.get(2)?,
                    track_number: r.get(3)?,
                    disc_number: r.get(4)?,
                    lyrics: r.get(5)?,
                    bpm: r.get(6)?,
                    tag_album: r.get(7)?,
                    tag_artist: r.get(8)?,
                    tag_album_artist: r.get(9)?,
                    track_total: r.get(10)?,
                    disc_total: r.get(11)?,
                    mb: [r.get(12)?, r.get(13)?, r.get(14)?, r.get(15)?],
                    edited: r.get(16)?,
                    user: r.get(17)?,
                    embedded: r.get(18)?,
                    tags_version: r.get(19)?,
                })
            },
        )
        .optional()?)
}

/// Field masks while merging one row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Masks {
    pub edited: i64,
    pub user: i64,
    pub embedded: i64,
}

/// One field of a fresh read meets the stored value.
///
/// - typed by a person: kept, unless `override_user` and the tag has a value;
/// - curated: kept, unless `prefer_embedded` and the tag has a value;
/// - otherwise the tag value; without one, the file-name fallback replaces a
///   value that came from the tags (the tag was removed) and only fills an
///   empty field otherwise.
///
/// `fresh` is false for writes that did not read the file: they only fill.
pub(crate) fn merge_field<T: Clone>(
    bit: i64,
    incoming: Option<T>,
    stored: Option<T>,
    from_tag: bool,
    masks: &mut Masks,
    policy: crate::embedded::MergePolicy,
    fresh: bool,
) -> Option<T> {
    let tag_value = from_tag && incoming.is_some();
    let typed = masks.user & bit != 0;
    let curated = masks.edited & bit != 0;
    if typed || curated {
        let replace =
            tag_value && (policy.override_user || (policy.prefer_embedded && !typed)) && fresh;
        if replace {
            masks.edited &= !bit;
            masks.user &= !bit;
            masks.embedded |= bit;
            return incoming;
        }
        if fresh {
            masks.embedded &= !bit;
        }
        return stored;
    }
    if !fresh {
        return incoming.or(stored);
    }
    if tag_value {
        masks.embedded |= bit;
        return incoming;
    }
    let was_embedded = masks.embedded & bit != 0;
    masks.embedded &= !bit;
    if was_embedded {
        incoming
    } else {
        incoming.or(stored)
    }
}

/// Bits of `embedded_fields` that only the tags provide (no curated value).
const TAG_ONLY_BITS: i64 = super::field::ALBUM
    | super::field::ARTIST
    | super::field::ALBUM_ARTIST
    | super::field::TRACK_TOTAL
    | super::field::DISC_TOTAL
    | super::field::MUSICBRAINZ;

pub(super) fn upsert_track(conn: &Connection, row: &TrackRow<'_>) -> Result<i64> {
    use super::field;
    let stored = stored_track(conn, row.rel_path)?.unwrap_or_default();
    let fresh = row.tags_version.is_some();
    let mut m = Masks {
        edited: stored.edited,
        user: stored.user,
        embedded: stored.embedded,
    };
    let from = |bit: i64| row.embedded_mask & bit != 0;
    let p = row.policy;
    let s = |v: Option<&str>| v.map(str::to_string);

    // Lyrics stored before 5.1 count as curated (they may come from a
    // fetch) until the file turns out to hold the very same text.
    if fresh && m.edited & field::LYRICS != 0 && m.user & field::LYRICS == 0 && from(field::LYRICS)
    {
        let same = matches!((row.lyrics, stored.lyrics.as_deref()),
            (Some(a), Some(b)) if a.trim() == b.trim());
        if same {
            m.edited &= !field::LYRICS;
        }
    }

    let title = merge_field(
        field::TITLE,
        s(Some(row.title)),
        stored.title.clone(),
        from(field::TITLE),
        &mut m,
        p,
        fresh,
    )
    .unwrap_or_else(|| row.title.to_string());
    let release_date = merge_field(
        field::RELEASE_DATE,
        s(row.release_date),
        stored.release_date.clone(),
        from(field::RELEASE_DATE),
        &mut m,
        p,
        fresh,
    );
    let genre = merge_field(
        field::GENRE,
        s(row.genre),
        stored.genre.clone(),
        from(field::GENRE),
        &mut m,
        p,
        fresh,
    );
    let track_number = merge_field(
        field::TRACK_NUMBER,
        row.track_number,
        stored.track_number,
        from(field::TRACK_NUMBER),
        &mut m,
        p,
        fresh,
    );
    let disc_number = merge_field(
        field::DISC_NUMBER,
        row.disc_number,
        stored.disc_number,
        from(field::DISC_NUMBER),
        &mut m,
        p,
        fresh,
    );
    let lyrics = merge_field(
        field::LYRICS,
        s(row.lyrics),
        stored.lyrics.clone(),
        from(field::LYRICS),
        &mut m,
        p,
        fresh,
    );
    let bpm = merge_field(
        field::BPM,
        row.bpm,
        stored.bpm,
        from(field::BPM),
        &mut m,
        p,
        fresh,
    );

    // Values only the tags provide: a fresh read replaces them.
    let tag_only = |incoming: Option<String>, stored: Option<String>| {
        if fresh {
            incoming
        } else {
            incoming.or(stored)
        }
    };
    let tag_album = tag_only(s(row.tag_album), stored.tag_album);
    let tag_artist = tag_only(s(row.tag_artist), stored.tag_artist);
    let tag_album_artist = tag_only(s(row.tag_album_artist), stored.tag_album_artist);
    let [mb0, mb1, mb2, mb3] = stored.mb;
    let mb_recording_id = tag_only(s(row.mb_recording_id), mb0);
    let mb_release_id = tag_only(s(row.mb_release_id), mb1);
    let mb_artist_id = tag_only(s(row.mb_artist_id), mb2);
    let mb_release_group_id = tag_only(s(row.mb_release_group_id), mb3);
    let (track_total, disc_total) = if fresh {
        (row.track_total, row.disc_total)
    } else {
        (
            row.track_total.or(stored.track_total),
            row.disc_total.or(stored.disc_total),
        )
    };
    if fresh {
        m.embedded = (m.embedded & !TAG_ONLY_BITS) | (row.embedded_mask & TAG_ONLY_BITS);
    }
    let tags_version = row.tags_version.unwrap_or(stored.tags_version);

    conn.execute(
        r#"
        INSERT INTO tracks(
          rel_path, file_path, album_id, artist_id, title, artist_name, album_name,
          duration_ms, track_number, size, mtime, genre, release_date, lyrics, bpm,
          disc_number, tag_album, tag_artist, tag_album_artist, track_total, disc_total,
          mb_recording_id, mb_release_id, mb_artist_id, mb_release_group_id,
          edited_fields, user_fields, embedded_fields, tags_version
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                  ?21,?22,?23,?24,?25,?26,?27,?28,?29)
        ON CONFLICT(rel_path) DO UPDATE SET
          file_path=excluded.file_path,
          album_id=excluded.album_id,
          artist_id=excluded.artist_id,
          title=excluded.title,
          artist_name=excluded.artist_name,
          album_name=excluded.album_name,
          duration_ms=excluded.duration_ms,
          track_number=excluded.track_number,
          disc_number=excluded.disc_number,
          size=excluded.size,
          mtime=excluded.mtime,
          genre=excluded.genre,
          release_date=excluded.release_date,
          lyrics=excluded.lyrics,
          bpm=excluded.bpm,
          tag_album=excluded.tag_album,
          tag_artist=excluded.tag_artist,
          tag_album_artist=excluded.tag_album_artist,
          track_total=excluded.track_total,
          disc_total=excluded.disc_total,
          mb_recording_id=excluded.mb_recording_id,
          mb_release_id=excluded.mb_release_id,
          mb_artist_id=excluded.mb_artist_id,
          mb_release_group_id=excluded.mb_release_group_id,
          edited_fields=excluded.edited_fields,
          user_fields=excluded.user_fields,
          embedded_fields=excluded.embedded_fields,
          tags_version=excluded.tags_version
        "#,
        params![
            row.rel_path,
            row.file_path.to_string_lossy().as_ref(),
            row.album_id,
            row.artist_id,
            title,
            row.artist_name,
            row.album_name,
            row.duration_ms,
            track_number,
            row.size as i64,
            row.mtime,
            genre,
            release_date,
            lyrics,
            bpm,
            disc_number,
            tag_album,
            tag_artist,
            tag_album_artist,
            track_total,
            disc_total,
            mb_recording_id,
            mb_release_id,
            mb_artist_id,
            mb_release_group_id,
            m.edited,
            m.user,
            m.embedded,
            tags_version
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM tracks WHERE rel_path = ?1",
        params![row.rel_path],
        |r| r.get(0),
    )?;
    if row.write_file_state {
        conn.execute(
            "INSERT INTO files(rel_path, size, mtime) VALUES (?1,?2,?3)
             ON CONFLICT(rel_path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime",
            params![row.rel_path, row.size as i64, row.mtime],
        )?;
    }
    Ok(id)
}

/// Re-point a track at its album/artist rows. `album_name` is the album's
/// current display title; it is only written when it actually differs, so a
/// routine scan does not bump `updated_at` (the delta cursor).
pub(super) fn relink_track(
    conn: &Connection,
    rel_path: &str,
    album_id: i64,
    artist_id: i64,
    artist_name: &str,
    album_name: &str,
) -> Result<()> {
    conn.execute(
        r#"
        UPDATE tracks SET
          album_id = ?2,
          artist_id = ?3,
          artist_name = ?4,
          album_name = ?5
        WHERE rel_path = ?1
          AND (album_id IS NOT ?2 OR artist_id IS NOT ?3
               OR artist_name <> ?4 OR album_name <> ?5)
        "#,
        params![rel_path, album_id, artist_id, artist_name, album_name],
    )?;
    Ok(())
}

/// Album display title: unless curated, the most common album tag of its
/// tracks, else the folder name (both through `album_display_title`). The
/// tracks' `album_name` follows.
pub(super) fn sync_album_display(
    conn: &Connection,
    album_id: i64,
    folder_title: &str,
    use_tags: bool,
) -> Result<()> {
    let tag: Option<String> = if use_tags {
        conn.query_row(
            r#"
            SELECT trim(tag_album) FROM tracks
            WHERE album_id = ?1 AND tag_album IS NOT NULL AND trim(tag_album) != ''
            GROUP BY trim(tag_album)
            ORDER BY COUNT(*) DESC, trim(tag_album)
            LIMIT 1
            "#,
            params![album_id],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let name = if use_tags {
        super::text::album_display_title(tag.as_deref().unwrap_or(folder_title))
    } else {
        folder_title.to_string()
    };
    conn.execute(
        &format!(
            "UPDATE albums SET name = ?2 WHERE id = ?1 AND (edited_fields & {}) = 0 AND name IS NOT ?2",
            super::field::TITLE
        ),
        params![album_id, name],
    )?;
    conn.execute(
        r#"
        UPDATE tracks SET album_name = (SELECT name FROM albums WHERE id = ?1)
        WHERE album_id = ?1
          AND album_name IS NOT (SELECT name FROM albums WHERE id = ?1)
        "#,
        params![album_id],
    )?;
    Ok(())
}

/// Most common value among the most precise dates (full date over year-month
/// over year).
fn best_track_date(dates: &[String]) -> Option<String> {
    let best = dates
        .iter()
        .map(|d| super::text::date_precision(d))
        .max()
        .filter(|p| *p > 0)?;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for d in dates
        .iter()
        .filter(|d| super::text::date_precision(d) == best)
    {
        *counts.entry(d.as_str()).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(d, _)| d.to_string())
}

/// Most common non-empty value of a track column in an album.
fn most_common_track_value(conn: &Connection, album_id: i64, col: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT trim({col}) FROM tracks WHERE album_id = ?1 AND {col} IS NOT NULL \
                 AND trim({col}) != '' GROUP BY trim({col}) ORDER BY COUNT(*) DESC, trim({col}) LIMIT 1"
            ),
            params![album_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Album genre / release date from its tracks when the album has none of its
/// own (curated values are kept; with `prefer_embedded` only typed ones). A
/// more precise track date of the same year replaces a bare year. Also the
/// album artist and MusicBrainz release id the tracks' tags agree on.
pub(super) fn backfill_album_meta_from_tracks(
    conn: &Connection,
    album_id: i64,
    prefer_embedded: bool,
) -> Result<()> {
    use super::field;
    let (edited, user, embedded, cur_date, cur_genre, cur_mb): (
        i64,
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT edited_fields, user_fields, embedded_fields, release_date, genre, \
         musicbrainz_release_id FROM albums WHERE id = ?1",
        params![album_id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        },
    )?;
    let mut stmt = conn.prepare("SELECT release_date, genre FROM tracks WHERE album_id = ?1")?;
    let rows: Vec<(Option<String>, Option<String>)> = stmt
        .query_map(params![album_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .flatten()
        .collect();
    // Curated album values stay, unless the embedded priority lets the
    // tracks' values replace the ones nobody typed.
    let open = |bit: i64| edited & bit == 0 || (prefer_embedded && user & bit == 0);
    let mut new_edited = edited;
    let mut new_embedded = embedded;
    if open(field::RELEASE_DATE) {
        let dates: Vec<String> = rows
            .iter()
            .filter_map(|(d, _)| d.as_deref().map(str::trim))
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .collect();
        if let Some(best) = best_track_date(&dates) {
            let cur = cur_date.as_deref().map(str::trim).unwrap_or("");
            let curated = edited & field::RELEASE_DATE != 0;
            let replace = cur.is_empty()
                || curated
                || (super::text::date_precision(cur) < super::text::date_precision(&best)
                    && best.starts_with(cur));
            if replace && cur != best {
                conn.execute(
                    "UPDATE albums SET release_date = ?2 WHERE id = ?1",
                    params![album_id, best],
                )?;
                new_edited &= !field::RELEASE_DATE;
                new_embedded |= field::RELEASE_DATE;
            }
        }
    }
    let genre_empty = cur_genre.as_deref().map(str::trim).unwrap_or("").is_empty();
    if open(field::GENRE) && (genre_empty || edited & field::GENRE != 0) {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for g in rows
            .iter()
            .filter_map(|(_, g)| g.as_deref().map(str::trim))
            .filter(|g| !g.is_empty())
        {
            *counts.entry(g).or_default() += 1;
        }
        if let Some((g, _)) = counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        {
            if cur_genre.as_deref().map(str::trim) != Some(g) {
                conn.execute(
                    "UPDATE albums SET genre = ?2 WHERE id = ?1",
                    params![album_id, g],
                )?;
                new_edited &= !field::GENRE;
                new_embedded |= field::GENRE;
            }
        }
    }
    let album_artist = most_common_track_value(conn, album_id, "tag_album_artist")?;
    if cur_mb.as_deref().map(str::trim).unwrap_or("").is_empty() {
        if let Some(mb) = most_common_track_value(conn, album_id, "mb_release_id")? {
            conn.execute(
                "UPDATE albums SET musicbrainz_release_id = ?2 WHERE id = ?1",
                params![album_id, mb],
            )?;
            new_embedded |= field::MUSICBRAINZ;
        }
    }
    if album_artist.is_some() {
        new_embedded |= field::ALBUM_ARTIST;
    } else {
        new_embedded &= !field::ALBUM_ARTIST;
    }
    conn.execute(
        "UPDATE albums SET tag_album_artist = ?2, edited_fields = ?3, embedded_fields = ?4 \
         WHERE id = ?1 AND (tag_album_artist IS NOT ?2 OR edited_fields IS NOT ?3 \
         OR embedded_fields IS NOT ?4)",
        params![album_id, album_artist, new_edited, new_embedded],
    )?;
    Ok(())
}

/// Where an album's cover comes from (see `embedded::cover`).
pub(super) fn set_album_cover_info(
    conn: &Connection,
    album_id: i64,
    source: Option<&str>,
    embedded_from: Option<Option<&str>>,
) -> Result<()> {
    match embedded_from {
        Some(from) => conn.execute(
            "UPDATE albums SET cover_source = ?2, embedded_cover_from = ?3 WHERE id = ?1 \
             AND (cover_source IS NOT ?2 OR embedded_cover_from IS NOT ?3)",
            params![album_id, source, from],
        )?,
        None => conn.execute(
            "UPDATE albums SET cover_source = ?2 WHERE id = ?1 AND cover_source IS NOT ?2",
            params![album_id, source],
        )?,
    };
    Ok(())
}

/// Cache-busting token for a cover file: changes with its size or mtime.
pub(super) fn cover_version_of(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Some(format!("{:x}-{:x}", mtime, meta.len()))
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Park the user links of every track matched by `track_filter` (a SQL
/// condition over alias `t`), so they survive the track rows being deleted.
fn park_user_links(conn: &Connection, track_filter: &str) -> Result<()> {
    let now = now_stamp();
    conn.execute(
        &format!(
            r#"
            INSERT OR REPLACE INTO parked_favorites(account_id, rel_path, created_at, parked_at)
            SELECT f.account_id, t.rel_path, f.created_at, ?1
            FROM favorites f JOIN tracks t ON t.id = f.track_id
            WHERE {track_filter}
            "#
        ),
        params![now],
    )?;
    conn.execute(
        &format!(
            r#"
            INSERT OR REPLACE INTO parked_playlist_tracks(playlist_id, rel_path, position, parked_at)
            SELECT pt.playlist_id, t.rel_path, pt.position, ?1
            FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
            WHERE {track_filter}
            "#
        ),
        params![now],
    )?;
    Ok(())
}

/// Park one user link for a rel_path that is not (yet) in the catalog.
pub(super) fn park_favorite(
    conn: &Connection,
    account_id: &str,
    rel_path: &str,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT OR IGNORE INTO parked_favorites(account_id, rel_path, created_at, parked_at)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        params![account_id, rel_path, created_at, now_stamp()],
    )?;
    Ok(())
}

pub(super) fn park_playlist_track(
    conn: &Connection,
    playlist_id: &str,
    rel_path: &str,
    position: i64,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT OR IGNORE INTO parked_playlist_tracks(playlist_id, rel_path, position, parked_at)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        params![playlist_id, rel_path, position, now_stamp()],
    )?;
    Ok(())
}

pub(super) fn track_id_by_rel(conn: &Connection, rel: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM tracks WHERE rel_path = ?1",
            params![rel],
            |r| r.get(0),
        )
        .optional()?)
}

fn fill_scan_seen(conn: &Connection, seen: &HashSet<String>) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS scan_seen (rel_path TEXT PRIMARY KEY); DELETE FROM scan_seen;",
    )?;
    let mut stmt = conn.prepare("INSERT OR IGNORE INTO scan_seen(rel_path) VALUES (?1)")?;
    for rel in seen {
        stmt.execute(params![rel])?;
    }
    Ok(())
}

/// Synthetic Xing frame of an indexed MP3, see [`CatalogBatch::set_mp3_seek_header`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mp3SeekHeaderRow {
    pub size: u64,
    /// Seconds since the epoch, as the scan stored it.
    pub mtime: i64,
    pub insert_at: u64,
    pub frame: Vec<u8>,
}

impl Db {
    /// The synthetic Xing frame stored for `rel_path`, if any.
    pub fn mp3_seek_header(&self, rel_path: &str) -> Result<Option<Mp3SeekHeaderRow>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "SELECT size, mtime, insert_at, frame FROM mp3_seek_headers WHERE rel_path = ?1",
                params![rel_path],
                |r| {
                    Ok(Mp3SeekHeaderRow {
                        size: r.get::<_, i64>(0)? as u64,
                        mtime: r.get(1)?,
                        insert_at: r.get::<_, i64>(2)? as u64,
                        frame: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Run catalog writes in one IMMEDIATE transaction (one commit, one fsync).
    pub fn write_batch<T>(&self, f: impl FnOnce(&CatalogBatch<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&CatalogBatch { conn: &tx })?;
        tx.commit()?;
        Ok(out)
    }

    /// Snapshot favorites/playlist membership by rel_path.
    ///
    /// Kept for callers that want an in-memory copy; catalog rebuilds no longer
    /// need it because user links are parked in the database.
    pub fn snapshot_user_links(&self) -> Result<UserLinkSnapshot> {
        let conn = self.lock();
        let mut favs = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT f.account_id, t.rel_path FROM favorites f JOIN tracks t ON t.id = f.track_id",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows.flatten() {
                favs.push(row);
            }
        }
        let mut playlist_tracks = Vec::new();
        {
            let mut stmt = conn.prepare(
                r#"
                SELECT pt.playlist_id, t.rel_path, pt.position
                FROM playlist_tracks pt
                JOIN tracks t ON t.id = pt.track_id
                "#,
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows.flatten() {
                playlist_tracks.push(row);
            }
        }
        Ok(UserLinkSnapshot {
            favorite_rel_paths: favs,
            playlist_tracks,
        })
    }

    /// Re-attach a snapshot; rel_paths not in the catalog are parked so they
    /// come back when their file is indexed.
    pub fn restore_user_links(&self, snap: &UserLinkSnapshot) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        for (account_id, rel) in &snap.favorite_rel_paths {
            match track_id_by_rel(&tx, rel)? {
                Some(id) => {
                    tx.execute(
                        "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
                        params![account_id, id, now],
                    )?;
                }
                None => park_favorite(&tx, account_id, rel, &now)?,
            }
        }
        for (playlist_id, rel, position) in &snap.playlist_tracks {
            match track_id_by_rel(&tx, rel)? {
                Some(id) => {
                    tx.execute(
                        "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
                        params![playlist_id, id, position],
                    )?;
                }
                None => park_playlist_track(&tx, playlist_id, rel, *position)?,
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn track_id_by_rel(&self, rel: &str) -> Result<Option<i64>> {
        track_id_by_rel(&self.lock(), rel)
    }

    /// `rel_path -> (size, mtime)` for every indexed file, to skip unchanged files.
    pub fn file_states(&self) -> Result<HashMap<String, (i64, i64)>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT f.rel_path, f.size, f.mtime
            FROM files f
            JOIN tracks t ON t.rel_path = f.rel_path
            "#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
        Ok(map)
    }

    /// Every indexed rel_path.
    pub fn all_track_rel_paths(&self) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT rel_path FROM tracks")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.flatten().collect())
    }

    /// Indexed rel_paths under `prefix/` (used to protect unreadable folders
    /// from being pruned).
    pub fn track_rel_paths_under(&self, prefix: &str) -> Result<Vec<String>> {
        let conn = self.lock();
        let prefix = prefix.trim_end_matches('/');
        let mut stmt =
            conn.prepare("SELECT rel_path FROM tracks WHERE substr(rel_path, 1, ?2) = ?1")?;
        let like = format!("{prefix}/");
        let rows = stmt.query_map(params![like, like.chars().count() as i64], |r| {
            r.get::<_, String>(0)
        })?;
        Ok(rows.flatten().collect())
    }

    /// Re-point an unchanged track at the current album/artist rows without
    /// touching any metadata edited from Studio.
    pub fn relink_track(
        &self,
        rel_path: &str,
        album_id: i64,
        artist_id: i64,
        artist_name: &str,
        album_name: &str,
    ) -> Result<()> {
        relink_track(
            &self.lock(),
            rel_path,
            album_id,
            artist_id,
            artist_name,
            album_name,
        )
    }

    /// Drop tracks whose files are no longer on disk, unconditionally. Their
    /// favorites / playlist entries are parked, not lost.
    pub fn prune_tracks_outside(&self, seen: &HashSet<String>) -> Result<u64> {
        Ok(self
            .prune_tracks_outside_guarded(seen, |_, _| Ok(()))?
            .removed)
    }

    /// Like [`Db::prune_tracks_outside`], but `allow(indexed, missing)` decides
    /// (inside the same transaction) whether the deletion may proceed; an `Err`
    /// reason leaves the catalog untouched and is reported back.
    pub fn prune_tracks_outside_guarded(
        &self,
        seen: &HashSet<String>,
        allow: impl FnOnce(u64, u64) -> std::result::Result<(), String>,
    ) -> Result<PruneOutcome> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        fill_scan_seen(&tx, seen)?;
        let indexed: i64 = tx.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        let missing: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tracks WHERE rel_path NOT IN (SELECT rel_path FROM scan_seen)",
            [],
            |r| r.get(0),
        )?;
        let mut outcome = PruneOutcome {
            indexed: indexed as u64,
            missing: missing as u64,
            ..Default::default()
        };
        if missing > 0 {
            if let Err(reason) = allow(outcome.indexed, outcome.missing) {
                tx.execute_batch("DELETE FROM scan_seen;")?;
                tx.commit()?;
                outcome.skipped = Some(reason);
                return Ok(outcome);
            }
        }
        park_user_links(&tx, "t.rel_path NOT IN (SELECT rel_path FROM scan_seen)")?;
        let removed = tx.execute(
            "DELETE FROM tracks WHERE rel_path NOT IN (SELECT rel_path FROM scan_seen)",
            [],
        )?;
        tx.execute(
            "DELETE FROM files WHERE rel_path NOT IN (SELECT rel_path FROM scan_seen)",
            [],
        )?;
        tx.execute(
            "DELETE FROM mp3_seek_headers WHERE rel_path NOT IN (SELECT rel_path FROM scan_seen)",
            [],
        )?;
        tx.execute_batch("DELETE FROM scan_seen;")?;
        tx.commit()?;
        outcome.removed = removed as u64;
        Ok(outcome)
    }

    pub fn prune_empty_albums(&self) -> Result<u64> {
        let conn = self.lock();
        let removed = conn.execute(
            "DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = albums.id)",
            [],
        )?;
        Ok(removed as u64)
    }

    pub fn prune_empty_artists(&self) -> Result<u64> {
        let conn = self.lock();
        let removed = conn.execute(
            r#"
            DELETE FROM artists
            WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = artists.id)
              AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.artist_id = artists.id)
            "#,
            [],
        )?;
        Ok(removed as u64)
    }

    /// Wipe the FS catalog in one transaction. Favorites / playlist membership
    /// are parked first and re-attach as the tracks are indexed again, so a
    /// crash halfway through a rebuild loses nothing.
    pub fn clear_catalog(&self) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        park_user_links(&tx, "1")?;
        tx.execute_batch(
            r#"
            DELETE FROM playlist_tracks;
            DELETE FROM favorites;
            DELETE FROM tracks_fts;
            DELETE FROM tracks;
            DELETE FROM albums;
            DELETE FROM artists;
            DELETE FROM files;
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Forget parked user links older than `days` (files that never came back).
    pub fn purge_parked_user_links(&self, days: i64) -> Result<u64> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let conn = self.lock();
        let a = conn.execute(
            "DELETE FROM parked_favorites WHERE parked_at < ?1",
            params![cutoff],
        )?;
        let b = conn.execute(
            "DELETE FROM parked_playlist_tracks WHERE parked_at < ?1",
            params![cutoff],
        )?;
        Ok((a + b) as u64)
    }

    /// `(parked favorites, parked playlist entries)` waiting for their file.
    pub fn parked_user_link_counts(&self) -> Result<(u64, u64)> {
        let conn = self.read();
        let a: i64 = conn.query_row("SELECT COUNT(*) FROM parked_favorites", [], |r| r.get(0))?;
        let b: i64 = conn.query_row("SELECT COUNT(*) FROM parked_playlist_tracks", [], |r| {
            r.get(0)
        })?;
        Ok((a as u64, b as u64))
    }

    pub fn upsert_artist(&self, name: &str) -> Result<i64> {
        upsert_artist(&self.lock(), name)
    }

    pub fn upsert_album(
        &self,
        name: &str,
        artist_name: &str,
        artist_id: Option<i64>,
        folder_key: &str,
        cover_path: Option<&Path>,
        loose: bool,
    ) -> Result<i64> {
        upsert_album(
            &self.lock(),
            name,
            artist_name,
            artist_id,
            folder_key,
            cover_path,
            loose,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_track(
        &self,
        rel_path: &str,
        file_path: &Path,
        title: &str,
        artist_name: &str,
        album_name: &str,
        duration_ms: i64,
        track_number: Option<i64>,
        album_id: Option<i64>,
        artist_id: Option<i64>,
        size: u64,
        mtime: i64,
        genre: Option<&str>,
        release_date: Option<&str>,
        lyrics: Option<&str>,
    ) -> Result<i64> {
        upsert_track(
            &self.lock(),
            &TrackRow {
                rel_path,
                file_path,
                title,
                artist_name,
                album_name,
                duration_ms,
                track_number,
                album_id,
                artist_id,
                size,
                mtime,
                genre,
                release_date,
                lyrics,
                bpm: None,
                disc_number: None,
                tag_album: None,
                tag_artist: None,
                tag_album_artist: None,
                track_total: None,
                disc_total: None,
                mb_recording_id: None,
                mb_release_id: None,
                mb_artist_id: None,
                mb_release_group_id: None,
                embedded_mask: 0,
                tags_version: None,
                policy: Default::default(),
                write_file_state: true,
            },
        )
    }

    pub fn rebuild_fts(&self) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
            DELETE FROM tracks_fts;
            INSERT INTO tracks_fts(rowid, title, artist_name, album_name, genre)
              SELECT id, title, artist_name, album_name, COALESCE(genre, '') FROM tracks;
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn refresh_counts(&self) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
            UPDATE albums SET track_count = (
              SELECT COUNT(*) FROM tracks t WHERE t.album_id = albums.id
            );
            UPDATE artists SET
              track_count = (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = artists.id),
              album_count = (SELECT COUNT(*) FROM albums a WHERE a.artist_id = artists.id);
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Fill album genre/release_date from track tags when album meta is empty.
    pub fn backfill_album_meta_from_tracks(&self, album_id: i64) -> Result<()> {
        let prefer = self.prefers_embedded();
        backfill_album_meta_from_tracks(&self.lock(), album_id, prefer)
    }
}
