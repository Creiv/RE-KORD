//! SQLite library database.
//!
//! - `migrations`: `PRAGMA user_version` schema migrations
//! - `catalog`: scan writes (batched), pruning, parked user links
//! - `user_data`: favorites and playlists
//! - `curated`: curated (sidecar / legacy / Studio) metadata writes
//! - `genres`: genre tokens and canonical labels
//! - `quality`: the library quality checks (dashboard alerts)
//! - `text`: display titles, dates, genre parsing, search folding
//! - this file: connection, read queries, studio metadata writes

mod catalog;
mod curated;
mod embedded;
mod genres;
mod migrations;
pub mod quality;
pub mod text;
mod user_data;

pub use catalog::{CatalogBatch, Mp3SeekHeaderRow, PruneOutcome, TrackRow};
pub use curated::{CuratedAlbumMeta, CuratedTrackMeta, CuratedWrite};
pub use embedded::{PendingCoverAlbum, PendingTrack};
pub use genres::{count_genres, GenreCount};

pub use migrations::SCHEMA_VERSION;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// How long a statement waits on a locked database before giving up.
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// Generic / stub genre values from ID3 (e.g. iTunes `"Music"`) that must not block
/// legacy / sidecar genre repair during fill-empty sync.
pub fn is_weak_genre(value: Option<&str>) -> bool {
    let Some(raw) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    if raw.chars().count() == 1 {
        return true;
    }
    if raw.len() <= 2 && raw.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    matches!(
        raw.to_ascii_lowercase().as_str(),
        "music"
            | "unknown"
            | "other"
            | "misc"
            | "miscellaneous"
            | "various"
            | "none"
            | "n/a"
            | "na"
            | "undefined"
            | "genre"
            | "null"
            | "unclassified"
            | "(null)"
            | "not classified"
    )
}

fn genre_part_count(s: &str) -> usize {
    s.split([';', '/', ','])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .count()
        .max(1)
}

/// Prefer legacy/incoming genre when hub is empty/stub, or when incoming is richer
/// (more `;`/`/`/`,` parts). Never install a weak incoming over a real hub genre.
pub fn should_replace_genre(current: Option<&str>, incoming: Option<&str>) -> bool {
    let Some(inc) = incoming.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if is_weak_genre(Some(inc)) {
        return false;
    }
    if is_weak_genre(current) {
        return true;
    }
    let cur = current.map(str::trim).unwrap_or("");
    if cur.eq_ignore_ascii_case(inc) {
        return false;
    }
    let inc_parts = genre_part_count(inc);
    let cur_parts = genre_part_count(cur);
    if inc_parts > cur_parts {
        return true;
    }
    inc_parts >= 2 && inc.len() > cur.len() + 6
}

/// Bits of `edited_fields` / `user_fields` on albums and tracks.
///
/// `edited_fields`: the value is curated (sidecar, legacy library, Studio,
/// metadata fetch) and a scan keeps it instead of the tag value.
/// `user_fields`: a person typed it; fetches and imports keep it too.
///
/// `embedded_fields` (tracks, albums) uses the same bits plus the ones only
/// tags provide: the value came from the file's own tags (see `embedded`).
pub mod field {
    pub const TITLE: i64 = 1;
    pub const RELEASE_DATE: i64 = 2;
    pub const GENRE: i64 = 4;
    pub const TRACK_NUMBER: i64 = 8;
    pub const DISC_NUMBER: i64 = 16;
    /// Curated once a fetch, a sidecar or a person stored them (5.1).
    pub const LYRICS: i64 = 32;
    pub const BPM: i64 = 64;
    /// Only ever from the tags (`embedded_fields`).
    pub const ALBUM: i64 = 128;
    pub const ARTIST: i64 = 256;
    pub const ALBUM_ARTIST: i64 = 512;
    pub const TRACK_TOTAL: i64 = 1024;
    pub const DISC_TOTAL: i64 = 2048;
    pub const MUSICBRAINZ: i64 = 4096;

    /// API names of the bits set in `mask`.
    pub fn names(mask: i64) -> Vec<&'static str> {
        [
            (TITLE, "title"),
            (RELEASE_DATE, "release_date"),
            (GENRE, "genre"),
            (TRACK_NUMBER, "track_number"),
            (DISC_NUMBER, "disc_number"),
            (LYRICS, "lyrics"),
            (BPM, "bpm"),
            (ALBUM, "album"),
            (ARTIST, "artist"),
            (ALBUM_ARTIST, "album_artist"),
            (TRACK_TOTAL, "track_total"),
            (DISC_TOTAL, "disc_total"),
            (MUSICBRAINZ, "musicbrainz"),
        ]
        .iter()
        .filter(|(bit, _)| mask & bit != 0)
        .map(|(_, name)| *name)
        .collect()
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
    /// Embedded priority "embedded" (see `embedded::EmbeddedPriority`):
    /// values taken from the tags are not replaced by sidecar fills, and
    /// album values derived from the tracks replace curated ones nobody typed.
    prefer_embedded: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub rel_path: String,
    pub title: String,
    pub artist_name: String,
    pub album_name: String,
    pub duration_ms: i64,
    pub track_number: Option<i64>,
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Tempo read from the tags; `null` when the file has none.
    #[serde(default)]
    pub bpm: Option<f64>,
}

impl AsRef<Track> for Track {
    fn as_ref(&self) -> &Track {
        self
    }
}

/// A track as the library API serves it: [`Track`] plus display extras.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryTrack {
    #[serde(flatten)]
    pub track: Track,
    /// File name on disk (`01 - Song.flac`).
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub disc_number: Option<i64>,
    /// `genre` split into tokens with one canonical label per genre.
    #[serde(default)]
    pub genres: Vec<String>,
    /// The album has cover art (skip cover requests when false).
    #[serde(default)]
    pub has_cover: bool,
    /// Changes when the album cover changes (`?v=` for cover URLs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// A person edited this track (Studio or legacy `user_edited`).
    #[serde(default)]
    pub user_edited: bool,
    /// Fields whose curated value wins over the file tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub curated_fields: Vec<String>,
    /// Fields whose value came from the file's embedded tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embedded_fields: Vec<String>,
    /// Track artist(s) as tagged (`artist_name` is the library artist).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_total: Option<i64>,
    /// MusicBrainz ids from the tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub musicbrainz: Option<MusicBrainzIds>,
}

/// MusicBrainz identifiers found in a file's tags.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MusicBrainzIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_group_id: Option<String>,
}

impl AsRef<Track> for LibraryTrack {
    fn as_ref(&self) -> &Track {
        &self.track
    }
}

impl std::ops::Deref for LibraryTrack {
    type Target = Track;
    fn deref(&self) -> &Track {
        &self.track
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub artist_name: String,
    pub track_count: i64,
    pub artist_id: Option<i64>,
    pub folder_key: String,
    pub has_cover: bool,
    pub loose: bool,
    /// True when album sidecar / studio meta was applied (parity legacy `hasAlbumMeta`).
    #[serde(default)]
    pub has_album_meta: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_track_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discogs_release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discogs_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discogs_extra: Option<crate::metadata::providers::DiscogsAlbumExtra>,
    /// Folder name on disk (`name` is the display title).
    #[serde(default)]
    pub folder_name: String,
    /// `genre` split into canonical tokens.
    #[serde(default)]
    pub genres: Vec<String>,
    /// Changes when the cover file changes (`?v=` for cover URLs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    /// Last change of title, dates, genre, cover or tracks ("recently updated").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub user_edited: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub curated_fields: Vec<String>,
    /// Values derived from the tracks' embedded tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embedded_fields: Vec<String>,
    /// Where the cover comes from: `folder`, `legacy` or `embedded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_source: Option<String>,
    /// Album artist the tracks' tags agree on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub musicbrainz_release_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub album_count: i64,
    pub track_count: i64,
    pub has_cover: bool,
}

/// Global FS catalog album (unfiltered by library selection).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogAlbumEntry {
    pub id: i64,
    pub name: String,
    /// Stable key (= old `relPath`).
    pub folder_key: String,
    pub artist: String,
    /// Stable artist key (= name).
    pub artist_id: String,
    pub track_count: i64,
    pub loose: bool,
    pub has_cover: bool,
}

/// Global FS catalog artist. `id` is the stable name key (not SQLite id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogArtistEntry {
    pub id: String,
    pub name: String,
    pub album_count: i64,
    pub track_count: i64,
    pub has_cover: bool,
    /// SQLite artist id for cover URLs; omitted when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_id: Option<i64>,
    pub rel_albums: Vec<CatalogAlbumEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogResponse {
    pub artists: Vec<CatalogArtistEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct UserLinkSnapshot {
    /// (account_id, rel_path)
    pub favorite_rel_paths: Vec<(String, String)>,
    /// playlist_id, rel_path, position (playlist already carries account_id)
    pub playlist_tracks: Vec<(String, String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistBackupTrack {
    pub rel_path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default)]
    pub album_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistBackup {
    /// Stable playlist identity (legacy playlist id): imports match on it,
    /// so same-name playlists stay separate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub tracks: Vec<PlaylistBackupTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryStats {
    pub track_count: i64,
    pub album_count: i64,
    pub artist_count: i64,
    pub music_root: Option<String>,
    pub last_scan_at: Option<String>,
    /// True while a library scan is running (filled by API layer).
    #[serde(default)]
    pub scanning: bool,
    /// Filesystem total capacity for the music_root volume (API layer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_total_bytes: Option<u64>,
    /// Filesystem available bytes for the music_root volume (API layer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_available_bytes: Option<u64>,
    /// Bumped after every scan (also subfolder rescans).
    #[serde(default)]
    pub index_epoch: u64,
    /// Albums (not loose) without cover art, in the account's library
    /// (definitions: [`quality`]).
    #[serde(default)]
    pub albums_without_cover: i64,
    /// Albums (not loose) without album metadata.
    #[serde(default)]
    pub albums_without_meta: i64,
    /// Tracks with neither a real genre nor a release date.
    #[serde(default)]
    pub tracks_without_meta: i64,
    #[serde(default)]
    pub loose_album_count: i64,
    /// Distinct canonical genres.
    #[serde(default)]
    pub genre_count: i64,
    /// Whole catalog, before the account's library selection.
    #[serde(default)]
    pub catalog_track_count: i64,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut conn = Connection::open(path.as_ref()).context("open sqlite")?;
        // Scans, the watcher and HTTP handlers share the file: wait for a busy
        // writer instead of failing with SQLITE_BUSY.
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        )?;
        migrations::run(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            prefer_embedded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// See [`Db::prefers_embedded`].
    pub fn set_prefer_embedded(&self, prefer: bool) {
        self.prefer_embedded
            .store(prefer, std::sync::atomic::Ordering::SeqCst);
    }

    /// The hub's embedded priority is "embedded > Studio".
    pub fn prefers_embedded(&self) -> bool {
        self.prefer_embedded
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Fold the WAL back into the main database file (and refresh planner
    /// stats). Call on shutdown so the file is self-contained when copied.
    /// Returns false when readers kept part of the WAL in use.
    pub fn checkpoint(&self) -> Result<bool> {
        let conn = self.lock();
        conn.execute_batch("PRAGMA optimize;")?;
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
        Ok(busy == 0)
    }

    /// Schema version (`PRAGMA user_version`) of the open database.
    pub fn schema_version(&self) -> Result<i64> {
        migrations::user_version(&self.lock())
    }

    /// The connection guard. A panic while holding it must not take the whole
    /// library down with a poisoned mutex: an open `Transaction` is rolled back
    /// when it is dropped during unwinding, so the connection stays consistent.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self.lock();
        f(&conn)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO library_meta(key, value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let conn = self.lock();
        let v = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn stats(&self, music_root: Option<String>) -> Result<LibraryStats> {
        let conn = self.lock();
        let track_count: i64 = conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        let album_count: i64 = conn.query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))?;
        let artist_count: i64 = conn.query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))?;
        let last_scan_at = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'last_scan_at'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let index_epoch = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'index_epoch'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let (albums_without_cover, albums_without_meta, loose_album_count): (i64, i64, i64) = conn
            .query_row(
                &format!(
                    "SELECT
                       COALESCE(SUM(CASE WHEN {} THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE WHEN {} THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(loose), 0)
                     FROM albums",
                    quality::ALBUM_MISSING_COVER_SQL,
                    quality::ALBUM_MISSING_META_SQL,
                ),
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
        let tracks_without_meta: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM tracks WHERE {}",
                quality::TRACK_MISSING_META_SQL
            ),
            [],
            |r| r.get(0),
        )?;
        let genre_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM genres WHERE track_count > 0",
            [],
            |r| r.get(0),
        )?;
        Ok(LibraryStats {
            track_count,
            album_count,
            artist_count,
            music_root,
            last_scan_at,
            scanning: false,
            disk_total_bytes: None,
            disk_available_bytes: None,
            index_epoch,
            albums_without_cover,
            albums_without_meta,
            tracks_without_meta,
            loose_album_count,
            genre_count,
            catalog_track_count: track_count,
        })
    }

    /// Bump and return the library index epoch (after a scan).
    pub fn bump_index_epoch(&self) -> Result<u64> {
        let conn = self.lock();
        let cur: u64 = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'index_epoch'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let next = cur + 1;
        conn.execute(
            "INSERT INTO library_meta(key, value) VALUES ('index_epoch', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![next.to_string()],
        )?;
        Ok(next)
    }

    const TRACK_COLS: &'static str = "id, rel_path, title, artist_name, album_name, duration_ms, \
         track_number, album_id, artist_id, genre, release_date, lyrics, source, url, bpm";
    const TRACK_COLS_T: &'static str = "t.id, t.rel_path, t.title, t.artist_name, t.album_name, t.duration_ms, \
         t.track_number, t.album_id, t.artist_id, t.genre, t.release_date, t.lyrics, t.source, t.url, t.bpm";

    fn map_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
        Ok(Track {
            id: row.get(0)?,
            rel_path: row.get(1)?,
            title: row.get(2)?,
            artist_name: row.get(3)?,
            album_name: row.get(4)?,
            duration_ms: row.get(5)?,
            track_number: row.get(6)?,
            album_id: row.get(7)?,
            artist_id: row.get(8)?,
            genre: row
                .get::<_, Option<String>>(9)?
                .filter(|s| !s.trim().is_empty()),
            release_date: row
                .get::<_, Option<String>>(10)?
                .filter(|s| !s.trim().is_empty()),
            lyrics: row
                .get::<_, Option<String>>(11)?
                .filter(|s| !s.trim().is_empty()),
            source: row
                .get::<_, Option<String>>(12)?
                .filter(|s| !s.trim().is_empty()),
            url: row
                .get::<_, Option<String>>(13)?
                .filter(|s| !s.trim().is_empty()),
            bpm: row.get::<_, Option<f64>>(14)?,
        })
    }

    /// [`Track`] columns (aliased `t`) plus the [`LibraryTrack`] extras;
    /// use with [`Db::RICH_FROM`].
    fn rich_cols() -> String {
        format!(
            "{}, t.disc_number, t.genres, t.added_at, t.updated_at, t.edited_fields, \
             t.user_fields, COALESCE(a.has_cover, 0), a.cover_version, t.embedded_fields, \
             t.tag_artist, t.tag_album_artist, t.track_total, t.disc_total, \
             t.mb_recording_id, t.mb_release_id, t.mb_artist_id, t.mb_release_group_id",
            Self::TRACK_COLS_T
        )
    }

    const RICH_FROM: &'static str = "FROM tracks t LEFT JOIN albums a ON a.id = t.album_id";

    fn map_library_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrack> {
        let track = Self::map_track(row)?;
        let has_cover = row.get::<_, i64>(21)? != 0;
        let mut genres = genres::parse_genres_json(row.get::<_, Option<String>>(16)?.as_deref());
        if genres.is_empty() {
            genres = text::split_genres(track.genre.as_deref().unwrap_or(""));
        }
        Ok(LibraryTrack {
            file_name: track
                .rel_path
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string(),
            disc_number: row.get(15)?,
            genres,
            has_cover,
            cover_version: if has_cover { row.get(22)? } else { None },
            added_at: row.get(17)?,
            updated_at: row.get(18)?,
            curated_fields: field::names(row.get::<_, i64>(19)?)
                .into_iter()
                .map(str::to_string)
                .collect(),
            user_edited: row.get::<_, i64>(20)? != 0,
            embedded_fields: field::names(row.get::<_, i64>(23)?)
                .into_iter()
                .map(str::to_string)
                .collect(),
            track_artist: non_empty(row.get(24)?),
            album_artist: non_empty(row.get(25)?),
            track_total: row.get(26)?,
            disc_total: row.get(27)?,
            musicbrainz: {
                let ids = MusicBrainzIds {
                    recording_id: non_empty(row.get(28)?),
                    release_id: non_empty(row.get(29)?),
                    artist_id: non_empty(row.get(30)?),
                    release_group_id: non_empty(row.get(31)?),
                };
                (ids != MusicBrainzIds::default()).then_some(ids)
            },
            track,
        })
    }

    /// Rich tracks for `tail` (WHERE / ORDER / LIMIT over `t` and `a`).
    fn query_library_tracks(
        &self,
        tail: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<LibraryTrack>> {
        let conn = self.lock();
        let sql = format!("SELECT {} {} {tail}", Self::rich_cols(), Self::RICH_FROM);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, Self::map_library_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Library order (artist, album, track number, title), for the API.
    pub fn list_library_tracks(&self, limit: i64, offset: i64) -> Result<Vec<LibraryTrack>> {
        self.query_library_tracks(
            "ORDER BY t.artist_name COLLATE NOCASE, t.album_name COLLATE NOCASE, \
             t.disc_number, t.track_number, t.title COLLATE NOCASE LIMIT ?1 OFFSET ?2",
            params![limit, offset],
        )
    }

    pub fn get_library_track(&self, id: i64) -> Result<Option<LibraryTrack>> {
        Ok(self
            .query_library_tracks("WHERE t.id = ?1", params![id])?
            .into_iter()
            .next())
    }

    pub fn library_album_tracks(&self, album_id: i64) -> Result<Vec<LibraryTrack>> {
        let mut tracks = self.query_library_tracks("WHERE t.album_id = ?1", params![album_id])?;
        tracks.sort_by(|a, b| {
            let fa = a.rel_path.rsplit('/').next().unwrap_or(a.rel_path.as_str());
            let fb = b.rel_path.rsplit('/').next().unwrap_or(b.rel_path.as_str());
            nat_cmp(fa, fb)
                .then_with(|| nat_cmp(&a.rel_path, &b.rel_path))
                .then_with(|| a.rel_path.cmp(&b.rel_path))
        });
        Ok(tracks)
    }

    fn map_album(row: &rusqlite::Row<'_>) -> rusqlite::Result<Album> {
        let discogs_release_id = row
            .get::<_, Option<String>>(14)?
            .filter(|s| !s.trim().is_empty());
        let discogs_extra_json = row
            .get::<_, Option<String>>(15)?
            .filter(|s| !s.trim().is_empty());
        let discogs_extra = discogs_extra_json.as_deref().and_then(|s| {
            serde_json::from_str::<crate::metadata::providers::DiscogsAlbumExtra>(s).ok()
        });
        let discogs_uri = discogs_extra
            .as_ref()
            .and_then(|e| e.discogs_uri.clone())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                discogs_release_id
                    .as_ref()
                    .map(|id| format!("https://www.discogs.com/release/{id}"))
            });
        Ok(Album {
            id: row.get(0)?,
            name: row.get(1)?,
            artist_name: row.get(2)?,
            track_count: row.get(3)?,
            artist_id: row.get(4)?,
            folder_key: row.get(5)?,
            has_cover: row.get::<_, i64>(6)? != 0,
            loose: row.get::<_, i64>(7)? != 0,
            has_album_meta: row.get::<_, i64>(8)? != 0,
            genre: row
                .get::<_, Option<String>>(9)?
                .filter(|s| !s.trim().is_empty()),
            release_date: row
                .get::<_, Option<String>>(10)?
                .filter(|s| !s.trim().is_empty()),
            label: row
                .get::<_, Option<String>>(11)?
                .filter(|s| !s.trim().is_empty()),
            country: row
                .get::<_, Option<String>>(12)?
                .filter(|s| !s.trim().is_empty()),
            expected_track_count: row.get(13)?,
            discogs_release_id,
            discogs_uri,
            discogs_extra,
            folder_name: String::new(),
            genres: genres::parse_genres_json(row.get::<_, Option<String>>(20)?.as_deref()),
            cover_version: row.get::<_, Option<String>>(21)?,
            added_at: row.get(18)?,
            updated_at: row.get(19)?,
            user_edited: row.get::<_, i64>(17)? != 0,
            curated_fields: field::names(row.get::<_, i64>(16)?)
                .into_iter()
                .map(str::to_string)
                .collect(),
            embedded_fields: field::names(row.get::<_, i64>(22)?)
                .into_iter()
                .map(str::to_string)
                .collect(),
            cover_source: non_empty(row.get(23)?),
            album_artist: non_empty(row.get(24)?),
            musicbrainz_release_id: non_empty(row.get(25)?),
        })
        .map(|mut a: Album| {
            a.folder_name = a
                .folder_key
                .rsplit('/')
                .next()
                .unwrap_or(&a.folder_key)
                .to_string();
            if !a.has_cover {
                a.cover_version = None;
                a.cover_source = None;
            }
            a
        })
    }

    const ALBUM_COLS: &'static str = "id, name, artist_name, track_count, artist_id, folder_key, \
         has_cover, loose, has_album_meta, genre, release_date, label, country, expected_track_count, \
         discogs_release_id, discogs_extra_json, edited_fields, user_fields, added_at, updated_at, \
         genres, cover_version, embedded_fields, cover_source, tag_album_artist, \
         musicbrainz_release_id";

    /// `embedded_cover_from` of an album (`None`: no such album, or never
    /// checked; `Some("")`: checked, no picture).
    pub fn album_embedded_cover_from(&self, folder_key: &str) -> Result<Option<String>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "SELECT embedded_cover_from FROM albums WHERE folder_key = ?1",
                params![folder_key],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn album_cover_path(&self, album_id: i64) -> Result<Option<PathBuf>> {
        let conn = self.lock();
        let p: Option<Option<String>> = conn
            .query_row(
                "SELECT cover_path FROM albums WHERE id = ?1 AND has_cover = 1",
                params![album_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.flatten().map(PathBuf::from))
    }

    /// Distinct cover files for thumbnail backfill.
    pub fn all_album_cover_paths(&self) -> Result<Vec<PathBuf>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT cover_path FROM albums WHERE has_cover = 1 AND cover_path IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.flatten().map(PathBuf::from).collect())
    }

    pub fn artist_cover_path(&self, artist_id: i64) -> Result<Option<PathBuf>> {
        let conn = self.lock();
        let p: Option<Option<String>> = conn
            .query_row(
                r#"
                SELECT cover_path FROM albums
                WHERE artist_id = ?1 AND has_cover = 1 AND cover_path IS NOT NULL
                ORDER BY loose ASC, name COLLATE NOCASE
                LIMIT 1
                "#,
                params![artist_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.flatten().map(PathBuf::from))
    }

    pub fn list_tracks(&self, limit: i64, offset: i64) -> Result<Vec<Track>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks
             ORDER BY artist_name COLLATE NOCASE, album_name COLLATE NOCASE,
                      track_number, title COLLATE NOCASE
             LIMIT ?1 OFFSET ?2",
            Self::TRACK_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Full-text track search over title, artist, album and genre: every word
    /// matches as a prefix, accents ignored. File paths are not searched.
    pub fn search_tracks(&self, q: &str, limit: i64) -> Result<Vec<LibraryTrack>> {
        let Some(m) = text::fts_query(q) else {
            return Ok(Vec::new());
        };
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks_fts f JOIN tracks t ON t.id = f.rowid
             LEFT JOIN albums a ON a.id = t.album_id
             WHERE tracks_fts MATCH ?1
             ORDER BY f.rank, t.title COLLATE NOCASE
             LIMIT ?2",
            Self::rich_cols()
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = match stmt.query_map(params![m, limit], Self::map_library_track) {
            Ok(rows) => rows,
            // A query FTS cannot parse matches nothing rather than failing.
            Err(_) => return Ok(Vec::new()),
        };
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Albums and artists for a search: by name (album title, folder or artist,
    /// accents ignored) or by genre of the album or of any of its tracks.
    pub fn search_albums_artists(&self, q: &str) -> Result<(Vec<Album>, Vec<Artist>)> {
        let needle = text::fold_search(q.trim());
        if needle.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let genre_hit = |labels: &[String]| {
            labels
                .iter()
                .any(|g| text::fold_search(g).contains(&needle))
        };
        let mut genre_albums = std::collections::HashSet::new();
        let mut genre_artists = std::collections::HashSet::new();
        let any_genre = self
            .genre_labels()?
            .values()
            .any(|label| text::fold_search(label).contains(&needle));
        if any_genre {
            let conn = self.lock();
            let mut stmt = conn.prepare(
                "SELECT album_id, artist_id, genres FROM tracks WHERE genres IS NOT NULL AND genres != '[]'",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            for (album_id, artist_id, raw) in rows.flatten() {
                if genre_hit(&genres::parse_genres_json(raw.as_deref())) {
                    genre_albums.extend(album_id);
                    genre_artists.extend(artist_id);
                }
            }
        }
        let albums: Vec<Album> = self
            .list_albums()?
            .into_iter()
            .filter(|a| {
                text::fold_search(&a.name).contains(&needle)
                    || text::fold_search(&a.folder_name).contains(&needle)
                    || text::fold_search(&a.artist_name).contains(&needle)
                    || genre_hit(&a.genres)
                    || genre_albums.contains(&a.id)
            })
            .collect();
        let artists: Vec<Artist> = self
            .list_artists()?
            .into_iter()
            .filter(|a| {
                text::fold_search(&a.name).contains(&needle) || genre_artists.contains(&a.id)
            })
            .collect();
        Ok((albums, artists))
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>> {
        let conn = self.lock();
        let sql = format!("SELECT {} FROM tracks WHERE id = ?1", Self::TRACK_COLS);
        let t = conn
            .query_row(&sql, params![id], Self::map_track)
            .optional()?;
        Ok(t)
    }

    pub fn track_file_path(&self, id: i64) -> Result<Option<PathBuf>> {
        let conn = self.lock();
        let p: Option<String> = conn
            .query_row(
                "SELECT file_path FROM tracks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.map(PathBuf::from))
    }

    pub fn track_file_path_by_rel(&self, rel: &str) -> Result<Option<PathBuf>> {
        let conn = self.lock();
        let p: Option<String> = conn
            .query_row(
                "SELECT file_path FROM tracks WHERE rel_path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.map(PathBuf::from))
    }

    /// Tracks changed since an RFC3339 instant, newest first, plus deletions.
    pub fn tracks_changed_since(
        &self,
        since: &str,
        limit: i64,
    ) -> Result<(Vec<LibraryTrack>, Vec<String>)> {
        let updated = self.query_library_tracks(
            "WHERE t.updated_at > ?1 ORDER BY t.updated_at LIMIT ?2",
            params![since, limit],
        )?;
        let conn = self.lock();
        let removed = {
            let mut stmt = conn.prepare(
                "SELECT rel_path FROM track_tombstones WHERE removed_at > ?1 ORDER BY removed_at LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![since, limit], |r| r.get::<_, String>(0))?;
            rows.flatten().collect::<Vec<_>>()
        };
        Ok((updated, removed))
    }

    /// Highest `updated_at` in the catalog: the client's delta cursor.
    pub fn library_revision(&self) -> Result<Option<String>> {
        let conn = self.lock();
        let track_rev: Option<String> = conn
            .query_row("SELECT MAX(updated_at) FROM tracks", [], |r| r.get(0))
            .optional()?
            .flatten();
        let tomb_rev: Option<String> = conn
            .query_row("SELECT MAX(removed_at) FROM track_tombstones", [], |r| {
                r.get(0)
            })
            .optional()?
            .flatten();
        Ok(match (track_rev, tomb_rev) {
            (Some(a), Some(b)) => Some(if a >= b { a } else { b }),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        })
    }

    pub fn count_tracks(&self) -> Result<i64> {
        let conn = self.lock();
        Ok(conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?)
    }

    pub fn list_albums(&self) -> Result<Vec<Album>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM albums ORDER BY artist_name COLLATE NOCASE, name COLLATE NOCASE",
            Self::ALBUM_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::map_album)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn album_tracks(&self, album_id: i64) -> Result<Vec<Track>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks WHERE album_id = ?1",
            Self::TRACK_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![album_id], Self::map_track)?;
        let mut tracks: Vec<Track> = rows.filter_map(|r| r.ok()).collect();
        sort_album_tracks(&mut tracks);
        Ok(tracks)
    }

    pub fn list_artists(&self) -> Result<Vec<Artist>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT a.id, a.name, a.album_count, a.track_count,
              EXISTS(
                SELECT 1 FROM albums al
                WHERE al.artist_id = a.id AND al.has_cover = 1
              ) AS has_cover
            FROM artists a
            ORDER BY a.name COLLATE NOCASE
            "#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Artist {
                id: r.get(0)?,
                name: r.get(1)?,
                album_count: r.get(2)?,
                track_count: r.get(3)?,
                has_cover: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_artist(&self, id: i64) -> Result<Option<Artist>> {
        let conn = self.lock();
        let a = conn
            .query_row(
                r#"
                SELECT a.id, a.name, a.album_count, a.track_count,
                  EXISTS(
                    SELECT 1 FROM albums al
                    WHERE al.artist_id = a.id AND al.has_cover = 1
                  ) AS has_cover
                FROM artists a WHERE a.id = ?1
                "#,
                params![id],
                |r| {
                    Ok(Artist {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        album_count: r.get(2)?,
                        track_count: r.get(3)?,
                        has_cover: r.get::<_, i64>(4)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(a)
    }

    pub fn artist_albums(&self, artist_id: i64) -> Result<Vec<Album>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM albums WHERE artist_id = ?1 ORDER BY loose ASC, name COLLATE NOCASE",
            Self::ALBUM_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![artist_id], Self::map_album)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Global catalog (not filtered by library selection).
    /// `summary`: omit `rel_albums`. `artist_id`: filter by artist name (stable key).
    pub fn build_catalog(&self, summary: bool, artist_id: Option<&str>) -> Result<CatalogResponse> {
        let artists = self.list_artists()?;
        let artist_filter = artist_id.map(|s| s.trim()).filter(|s| !s.is_empty());
        let mut out = Vec::new();
        for a in artists {
            if let Some(want) = artist_filter {
                if a.name != want && a.id.to_string() != want {
                    continue;
                }
            }
            let rel_albums = if summary {
                Vec::new()
            } else {
                self.artist_albums(a.id)?
                    .into_iter()
                    .map(|al| CatalogAlbumEntry {
                        id: al.id,
                        name: al.name,
                        folder_key: al.folder_key,
                        artist: al.artist_name,
                        artist_id: a.name.clone(),
                        track_count: al.track_count,
                        loose: al.loose,
                        has_cover: al.has_cover,
                    })
                    .collect()
            };
            out.push(CatalogArtistEntry {
                id: a.name.clone(),
                name: a.name,
                album_count: a.album_count,
                track_count: a.track_count,
                has_cover: a.has_cover,
                db_id: Some(a.id),
                rel_albums,
            });
        }
        Ok(CatalogResponse { artists: out })
    }

    pub fn get_album(&self, id: i64) -> Result<Option<Album>> {
        let conn = self.lock();
        let sql = format!("SELECT {} FROM albums WHERE id = ?1", Self::ALBUM_COLS);
        let a = conn
            .query_row(&sql, params![id], Self::map_album)
            .optional()?;
        Ok(a)
    }

    pub fn track_by_rel(&self, rel: &str) -> Result<Option<Track>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks WHERE rel_path = ?1",
            Self::TRACK_COLS
        );
        let row = conn
            .query_row(&sql, params![rel], Self::map_track)
            .optional()?;
        Ok(row)
    }

    pub fn tracks_by_album_folder(&self, folder_key: &str) -> Result<Vec<Track>> {
        let conn = self.lock();
        let sql = format!(
            "SELECT {} FROM tracks t
             JOIN albums a ON a.id = t.album_id
             WHERE a.folder_key = ?1",
            Self::TRACK_COLS_T
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![folder_key], Self::map_track)?;
        let mut tracks: Vec<Track> = rows.filter_map(|r| r.ok()).collect();
        sort_album_tracks(&mut tracks);
        Ok(tracks)
    }

    /// Studio edit of a track (a person typed it): curated and user-owned.
    pub fn save_track_fields(
        &self,
        rel_path: &str,
        title: Option<&str>,
        genre: Option<&str>,
        release_date: Option<&str>,
        lyrics: Option<&str>,
    ) -> Result<()> {
        self.apply_curated_track(
            rel_path,
            &CuratedTrackMeta {
                title: title.map(str::to_string),
                genre: genre.map(str::to_string),
                release_date: release_date.map(str::to_string),
                lyrics: lyrics.map(str::to_string),
                ..Default::default()
            },
            CuratedWrite::User,
        )?;
        Ok(())
    }

    /// Studio edit of an album (a person typed it): curated and user-owned.
    pub fn save_album_fields(
        &self,
        folder_key: &str,
        name: Option<&str>,
        genre: Option<&str>,
        release_date: Option<&str>,
        label: Option<&str>,
    ) -> Result<()> {
        self.apply_curated_album(
            folder_key,
            &CuratedAlbumMeta {
                title: name.map(str::to_string),
                genre: genre.map(str::to_string),
                release_date: release_date.map(str::to_string),
                label: label.map(str::to_string),
                ..Default::default()
            },
            CuratedWrite::User,
        )?;
        Ok(())
    }

    pub fn delete_track_by_rel(&self, rel_path: &str) -> Result<bool> {
        let conn = self.lock();
        genres::forget_track_genres(&conn, "rel_path = ?1", &rel_path)?;
        let n = conn.execute("DELETE FROM tracks WHERE rel_path = ?1", params![rel_path])?;
        let _ = conn.execute("DELETE FROM files WHERE rel_path = ?1", params![rel_path]);
        Ok(n > 0)
    }

    pub fn delete_album_by_folder(&self, folder_key: &str) -> Result<bool> {
        let conn = self.lock();
        let album_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM albums WHERE folder_key = ?1",
                params![folder_key],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = album_id else {
            return Ok(false);
        };
        // Before the track rows, while the rel paths are still reachable: the two
        // tables are kept in step everywhere else, so an album delete should not
        // be the one place that leaves `files` rows behind.
        conn.execute(
            "DELETE FROM files WHERE rel_path IN (SELECT rel_path FROM tracks WHERE album_id = ?1)",
            params![id],
        )?;
        genres::forget_track_genres(&conn, "album_id = ?1", &id)?;
        conn.execute("DELETE FROM tracks WHERE album_id = ?1", params![id])?;
        let n = conn.execute("DELETE FROM albums WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Album metadata from Studio: a manual save (`source == "manual"`) is a
    /// user edit; a fetch / Discogs apply replaces anything a person did not
    /// type. Values become curated, so rescans keep them.
    pub fn apply_album_meta(
        &self,
        folder_key: &str,
        meta: &crate::metadata::providers::FetchedAlbumMeta,
    ) -> Result<()> {
        let manual = meta.source.as_deref() == Some("manual");
        self.apply_curated_album(
            folder_key,
            &CuratedAlbumMeta {
                title: meta.title.clone(),
                release_date: meta.release_date.clone(),
                genre: meta.genre.clone(),
                label: meta.label.clone(),
                country: meta.country.clone(),
                musicbrainz_release_id: meta.musicbrainz_release_id.clone(),
                discogs_release_id: meta.discogs_release_id.clone(),
                discogs_extra_json: meta.discogs_extra_json_for_db(),
                expected_track_count: meta.expected_track_count,
                ..Default::default()
            },
            if manual {
                CuratedWrite::User
            } else {
                CuratedWrite::Override
            },
        )?;
        Ok(())
    }

    /// Clear 1-char / short-numeric / generic-stub values left by bad edits or ID3
    /// (e.g. genre `"e"`, `"Music"`). Leaves real genres intact.
    pub fn clear_weak_studio_placeholders(&self) -> Result<(u32, u32)> {
        let conn = self.lock();
        let albums = conn.execute(
            r#"
            UPDATE albums SET
              genre = CASE
                WHEN genre IS NOT NULL AND (
                  length(trim(genre)) = 1
                  OR (length(trim(genre)) <= 2 AND trim(genre) GLOB '[0-9]*')
                  OR lower(trim(genre)) IN (
                    'music','unknown','other','misc','miscellaneous','various',
                    'none','n/a','na','undefined','genre','null','unclassified',
                    '(null)','not classified'
                  )
                ) THEN NULL ELSE genre END,
              release_date = CASE
                WHEN release_date IS NOT NULL AND (
                  length(trim(release_date)) = 1
                  OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
                ) THEN NULL ELSE release_date END,
              label = CASE
                WHEN label IS NOT NULL AND (
                  length(trim(label)) = 1
                  OR (length(trim(label)) <= 2 AND trim(label) GLOB '[0-9]*')
                ) THEN NULL ELSE label END
            WHERE
              (genre IS NOT NULL AND (
                length(trim(genre)) = 1
                OR (length(trim(genre)) <= 2 AND trim(genre) GLOB '[0-9]*')
                OR lower(trim(genre)) IN (
                  'music','unknown','other','misc','miscellaneous','various',
                  'none','n/a','na','undefined','genre','null','unclassified',
                  '(null)','not classified'
                )
              ))
              OR (release_date IS NOT NULL AND (
                length(trim(release_date)) = 1
                OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
              ))
              OR (label IS NOT NULL AND (
                length(trim(label)) = 1
                OR (length(trim(label)) <= 2 AND trim(label) GLOB '[0-9]*')
              ))
            "#,
            [],
        )?;
        let tracks = conn.execute(
            r#"
            UPDATE tracks SET
              genre = CASE
                WHEN genre IS NOT NULL AND (
                  length(trim(genre)) = 1
                  OR (length(trim(genre)) <= 2 AND trim(genre) GLOB '[0-9]*')
                  OR lower(trim(genre)) IN (
                    'music','unknown','other','misc','miscellaneous','various',
                    'none','n/a','na','undefined','genre','null','unclassified',
                    '(null)','not classified'
                  )
                ) THEN NULL ELSE genre END,
              release_date = CASE
                WHEN release_date IS NOT NULL AND (
                  length(trim(release_date)) = 1
                  OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
                ) THEN NULL ELSE release_date END
            WHERE
              (genre IS NOT NULL AND (
                length(trim(genre)) = 1
                OR (length(trim(genre)) <= 2 AND trim(genre) GLOB '[0-9]*')
                OR lower(trim(genre)) IN (
                  'music','unknown','other','misc','miscellaneous','various',
                  'none','n/a','na','undefined','genre','null','unclassified',
                  '(null)','not classified'
                )
              ))
              OR (release_date IS NOT NULL AND (
                length(trim(release_date)) = 1
                OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
              ))
            "#,
            [],
        )?;
        Ok((albums as u32, tracks as u32))
    }

    /// Fill empty/placeholder album studio fields from backup/legacy metadata.
    /// Does not overwrite richer existing values. Returns true if any column was written.
    /// Genre: also replaces ID3 stubs like `"Music"` / `"e"` when legacy has a real genre,
    /// or when legacy genre is richer (more `;`/`/`/`,` parts).
    pub fn fill_album_meta_empty(
        &self,
        folder_key: &str,
        meta: &crate::metadata::providers::FetchedAlbumMeta,
    ) -> Result<bool> {
        let discogs_extra_json = meta.discogs_extra_json_for_db();
        let conn = self.lock();
        let cur_genre: Option<String> = conn
            .query_row(
                "SELECT genre FROM albums WHERE folder_key = ?1",
                params![folder_key],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let genre_in = if should_replace_genre(cur_genre.as_deref(), meta.genre.as_deref()) {
            meta.genre.clone()
        } else {
            None
        };
        // Treat 1-char / short numeric stubs (e.g. date "3") as empty so legacy can repair.
        let n = conn.execute(
            r#"
            UPDATE albums SET
              release_date = CASE
                WHEN (
                  release_date IS NULL OR trim(release_date) = ''
                  OR length(trim(release_date)) = 1
                  OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
                ) AND ?2 IS NOT NULL THEN ?2
                ELSE release_date END,
              genre = CASE
                WHEN ?3 IS NOT NULL THEN ?3
                ELSE genre END,
              label = CASE
                WHEN (
                  label IS NULL OR trim(label) = ''
                  OR length(trim(label)) = 1
                  OR (length(trim(label)) <= 2 AND trim(label) GLOB '[0-9]*')
                ) AND ?4 IS NOT NULL THEN ?4
                ELSE label END,
              country = CASE
                WHEN (country IS NULL OR trim(country) = '') AND ?5 IS NOT NULL THEN ?5
                ELSE country END,
              musicbrainz_release_id = CASE
                WHEN (musicbrainz_release_id IS NULL OR trim(musicbrainz_release_id) = '')
                  AND ?6 IS NOT NULL THEN ?6
                ELSE musicbrainz_release_id END,
              discogs_release_id = CASE
                WHEN (discogs_release_id IS NULL OR trim(discogs_release_id) = '')
                  AND ?7 IS NOT NULL THEN ?7
                ELSE discogs_release_id END,
              expected_track_count = CASE
                WHEN expected_track_count IS NULL AND ?8 IS NOT NULL THEN ?8
                ELSE expected_track_count END,
              name = CASE
                WHEN (name IS NULL OR trim(name) = '') AND ?9 IS NOT NULL AND trim(?9) != '' THEN ?9
                ELSE name END,
              discogs_extra_json = CASE
                WHEN (discogs_extra_json IS NULL OR trim(discogs_extra_json) = '')
                  AND ?10 IS NOT NULL THEN ?10
                ELSE discogs_extra_json END,
              has_album_meta = CASE
                WHEN ?2 IS NOT NULL OR ?3 IS NOT NULL OR ?4 IS NOT NULL OR ?5 IS NOT NULL
                  OR ?6 IS NOT NULL OR ?7 IS NOT NULL OR ?8 IS NOT NULL OR ?9 IS NOT NULL
                  OR ?10 IS NOT NULL
                THEN 1 ELSE has_album_meta END
            WHERE folder_key = ?1
              AND (
                ?2 IS NOT NULL OR ?3 IS NOT NULL OR ?4 IS NOT NULL OR ?5 IS NOT NULL
                OR ?6 IS NOT NULL OR ?7 IS NOT NULL OR ?8 IS NOT NULL OR ?9 IS NOT NULL
                OR ?10 IS NOT NULL
              )
            "#,
            params![
                folder_key,
                meta.release_date,
                genre_in,
                meta.label,
                meta.country,
                meta.musicbrainz_release_id,
                meta.discogs_release_id,
                meta.expected_track_count,
                meta.title,
                discogs_extra_json,
            ],
        )?;
        Ok(n > 0)
    }

    /// Album genre saved by a person, copied onto its tracks (user-owned).
    pub fn set_album_tracks_genre(&self, folder_key: &str, genre: &str) -> Result<()> {
        let rels: Vec<String> = {
            let conn = self.lock();
            let mut stmt = conn.prepare(
                "SELECT t.rel_path FROM tracks t JOIN albums a ON a.id = t.album_id WHERE a.folder_key = ?1",
            )?;
            let rows = stmt.query_map(params![folder_key], |r| r.get::<_, String>(0))?;
            rows.flatten().collect()
        };
        let meta = CuratedTrackMeta {
            genre: Some(genre.to_string()),
            ..Default::default()
        };
        let batch: Vec<(String, CuratedTrackMeta)> =
            rels.into_iter().map(|r| (r, meta.clone())).collect();
        self.apply_curated_batch(&[], &batch, CuratedWrite::User)?;
        Ok(())
    }

    /// Track metadata from Studio: a manual save is a user edit, a fetch
    /// replaces only what a person did not type. Existing lyrics are only
    /// replaced by a manual save.
    pub fn apply_track_meta(
        &self,
        rel_path: &str,
        meta: &crate::metadata::providers::FetchedTrackMeta,
    ) -> Result<()> {
        let manual = meta.source.as_deref() == Some("manual");
        self.apply_curated_track(
            rel_path,
            &CuratedTrackMeta {
                title: meta.title.clone(),
                release_date: meta.release_date.clone(),
                genre: meta.genre.clone(),
                track_number: meta.track_number,
                disc_number: meta.disc_number,
                lyrics: meta.lyrics.clone(),
                source: meta.source.clone(),
                url: meta.url.clone(),
                ..Default::default()
            },
            if manual {
                CuratedWrite::User
            } else {
                CuratedWrite::Override
            },
        )?;
        Ok(())
    }

    /// Write what a Discogs release says about one track: track/disc number,
    /// source and url always; title only when given (the caller passes it for
    /// untitled files); duration only when the file's own is unknown. Values
    /// a person typed are kept.
    pub fn apply_discogs_track_meta(
        &self,
        rel_path: &str,
        meta: &crate::metadata::providers::FetchedTrackMeta,
    ) -> Result<bool> {
        self.apply_curated_track(
            rel_path,
            &CuratedTrackMeta {
                title: meta.title.clone(),
                track_number: meta.track_number,
                disc_number: meta.disc_number,
                source: meta.source.clone(),
                url: meta.url.clone(),
                duration_ms: meta.duration_ms,
                ..Default::default()
            },
            CuratedWrite::Override,
        )
    }

    /// Fill empty/placeholder track studio fields from backup/legacy metadata.
    /// Track/disc numbers are not imported (parity with legacy restore).
    /// Genre: replaces ID3 stubs like `"Music"` when legacy has a real/richer genre.
    pub fn fill_track_meta_empty(
        &self,
        rel_path: &str,
        meta: &crate::metadata::providers::FetchedTrackMeta,
    ) -> Result<bool> {
        let conn = self.lock();
        let cur_genre: Option<String> = conn
            .query_row(
                "SELECT genre FROM tracks WHERE rel_path = ?1",
                params![rel_path],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let genre_in = if should_replace_genre(cur_genre.as_deref(), meta.genre.as_deref()) {
            meta.genre.clone()
        } else {
            None
        };
        let n = conn.execute(
            r#"
            UPDATE tracks SET
              title = CASE
                WHEN (title IS NULL OR trim(title) = '') AND ?2 IS NOT NULL THEN ?2
                ELSE title END,
              genre = CASE
                WHEN ?3 IS NOT NULL THEN ?3
                ELSE genre END,
              release_date = CASE
                WHEN (
                  release_date IS NULL OR trim(release_date) = ''
                  OR length(trim(release_date)) = 1
                  OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
                ) AND ?4 IS NOT NULL THEN ?4
                ELSE release_date END,
              source = CASE
                WHEN (source IS NULL OR trim(source) = '') AND ?5 IS NOT NULL THEN ?5
                ELSE source END,
              url = CASE
                WHEN (url IS NULL OR trim(url) = '') AND ?6 IS NOT NULL THEN ?6
                ELSE url END,
              lyrics = CASE
                WHEN (lyrics IS NULL OR trim(lyrics) = '') AND ?7 IS NOT NULL THEN ?7
                ELSE lyrics END
            WHERE rel_path = ?1
              AND (
                ((title IS NULL OR trim(title) = '') AND ?2 IS NOT NULL)
                OR (?3 IS NOT NULL)
                OR ((
                  release_date IS NULL OR trim(release_date) = ''
                  OR length(trim(release_date)) = 1
                  OR (length(trim(release_date)) <= 2 AND trim(release_date) GLOB '[0-9]*')
                ) AND ?4 IS NOT NULL)
                OR ((source IS NULL OR trim(source) = '') AND ?5 IS NOT NULL)
                OR ((url IS NULL OR trim(url) = '') AND ?6 IS NOT NULL)
                OR ((lyrics IS NULL OR trim(lyrics) = '') AND ?7 IS NOT NULL)
              )
            "#,
            params![
                rel_path,
                meta.title,
                genre_in,
                meta.release_date,
                meta.source,
                meta.url,
                meta.lyrics,
            ],
        )?;
        Ok(n > 0)
    }

    /// Resolve a track under an album folder by file name (case-insensitive basename).
    pub fn resolve_track_rel_in_album(
        &self,
        folder_key: &str,
        file_name: &str,
    ) -> Result<Option<String>> {
        let conn = self.lock();
        let want = file_name.to_ascii_lowercase();
        let mut stmt = conn.prepare(
            r#"
            SELECT t.rel_path FROM tracks t
            JOIN albums a ON a.id = t.album_id
            WHERE a.folder_key = ?1
            "#,
        )?;
        let rows = stmt.query_map(params![folder_key], |r| r.get::<_, String>(0))?;
        for rel in rows.flatten() {
            let base = Path::new(&rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if base == want {
                return Ok(Some(rel));
            }
        }
        // Fallback: relative path already includes folder
        let joined = format!(
            "{}/{}",
            folder_key.trim_end_matches('/').replace('\\', "/"),
            file_name
        );
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM tracks WHERE rel_path = ?1",
                params![joined],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        Ok(if exists { Some(joined) } else { None })
    }

    /// Point an album at its new cover file. Returns the new `cover_version`
    /// (the same value the library API reports), so the caller can hand it to
    /// the client for cache-busting without a second read.
    pub fn set_album_cover_path(&self, folder_key: &str, cover: &Path) -> Result<Option<String>> {
        let conn = self.lock();
        let cover_s = cover.to_string_lossy().into_owned();
        let version = catalog::cover_version_of(cover);
        conn.execute(
            r#"
            UPDATE albums SET cover_path = ?2, has_cover = 1, cover_version = ?3,
              cover_source = 'folder'
            WHERE folder_key = ?1
            "#,
            params![folder_key, cover_s, version],
        )?;
        Ok(version)
    }

    pub fn all_album_folder_keys(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT folder_key FROM albums")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

/// Album track order (parity legacy `albumExpectedOrder.mjs`): the on-disk
/// file name with numeric runs compared by value, i.e. download / folder order.
/// ID3 track numbers are deliberately ignored, so an untagged `10-x` sorts
/// after `2-y` and a mis-tagged file cannot jump around.
pub fn sort_album_tracks(tracks: &mut [Track]) {
    tracks.sort_by(|a, b| {
        let fa = a.rel_path.rsplit('/').next().unwrap_or(a.rel_path.as_str());
        let fb = b.rel_path.rsplit('/').next().unwrap_or(b.rel_path.as_str());
        nat_cmp(fa, fb)
            .then_with(|| nat_cmp(&a.rel_path, &b.rel_path))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
}

/// Numeric-aware, case-insensitive string compare (parity with JS
/// `localeCompare(…, { numeric: true, sensitivity: "base" })`).
pub fn nat_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ac), Some(bc)) if ac.is_ascii_digit() && bc.is_ascii_digit() => {
                let mut an: u64 = 0;
                while let Some(c) = ai.peek().copied() {
                    if c.is_ascii_digit() {
                        an = an
                            .saturating_mul(10)
                            .saturating_add((c as u8 - b'0') as u64);
                        ai.next();
                    } else {
                        break;
                    }
                }
                let mut bn: u64 = 0;
                while let Some(c) = bi.peek().copied() {
                    if c.is_ascii_digit() {
                        bn = bn
                            .saturating_mul(10)
                            .saturating_add((c as u8 - b'0') as u64);
                        bi.next();
                    } else {
                        break;
                    }
                }
                match an.cmp(&bn) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(ac), Some(bc)) => {
                let al = ac.to_lowercase();
                let bl = bc.to_lowercase();
                match al.cmp(bl) {
                    Ordering::Equal => {
                        ai.next();
                        bi.next();
                    }
                    other => return other,
                }
            }
        }
    }
}

#[cfg(test)]
mod genre_fill_tests {
    use super::{is_weak_genre, should_replace_genre};

    #[test]
    fn music_stub_is_weak() {
        assert!(is_weak_genre(Some("Music")));
        assert!(is_weak_genre(Some(" music ")));
        assert!(is_weak_genre(Some("e")));
        assert!(is_weak_genre(None));
        assert!(!is_weak_genre(Some("Hip Hop")));
    }

    #[test]
    fn replace_music_with_hip_hop() {
        assert!(should_replace_genre(Some("Music"), Some("Hip Hop")));
        assert!(!should_replace_genre(Some("Hip Hop"), Some("Music")));
        assert!(!should_replace_genre(Some("Hip Hop"), Some("Hip Hop")));
    }

    #[test]
    fn prefer_richer_multi_genre() {
        assert!(should_replace_genre(
            Some("Hip Hop"),
            Some("Electronic; Hip Hop; Pop Rap")
        ));
        assert!(!should_replace_genre(
            Some("Electronic; Hip Hop; Pop Rap"),
            Some("Hip Hop")
        ));
    }
}
