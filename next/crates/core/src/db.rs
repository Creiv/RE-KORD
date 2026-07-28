use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_track_count: Option<i64>,
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
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path.as_ref()).context("open sqlite")?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS artists (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              album_count INTEGER NOT NULL DEFAULT 0,
              track_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tracks (
              id INTEGER PRIMARY KEY,
              rel_path TEXT NOT NULL UNIQUE,
              file_path TEXT NOT NULL,
              album_id INTEGER,
              artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
              title TEXT NOT NULL,
              artist_name TEXT NOT NULL DEFAULT '',
              album_name TEXT NOT NULL DEFAULT '',
              duration_ms INTEGER NOT NULL DEFAULT 0,
              track_number INTEGER,
              size INTEGER NOT NULL DEFAULT 0,
              mtime INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS files (
              rel_path TEXT PRIMARY KEY,
              size INTEGER NOT NULL,
              mtime INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS library_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS favorites (
              account_id TEXT NOT NULL,
              track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
              created_at TEXT NOT NULL,
              PRIMARY KEY (account_id, track_id)
            );

            CREATE TABLE IF NOT EXISTS playlists (
              id TEXT PRIMARY KEY,
              account_id TEXT NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
              playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
              track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
              position INTEGER NOT NULL,
              PRIMARY KEY (playlist_id, track_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            "#,
        )?;

        Self::migrate_user_data_account_id(&conn)?;

        let album_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='albums'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let needs_album_v2 = album_sql
            .as_deref()
            .map(|s| !s.contains("folder_key"))
            .unwrap_or(true);
        if needs_album_v2 {
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS albums;
                CREATE TABLE albums (
                  id INTEGER PRIMARY KEY,
                  artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
                  name TEXT NOT NULL,
                  artist_name TEXT NOT NULL DEFAULT '',
                  folder_key TEXT NOT NULL UNIQUE,
                  cover_path TEXT,
                  has_cover INTEGER NOT NULL DEFAULT 0,
                  loose INTEGER NOT NULL DEFAULT 0,
                  track_count INTEGER NOT NULL DEFAULT 0
                );
                "#,
            )?;
        }

        let fts_ok: bool = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='tracks_fts'",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .map(|sql| !sql.contains("content="))
            .unwrap_or(false);
        if !fts_ok {
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS tracks_fts;
                CREATE VIRTUAL TABLE tracks_fts USING fts5(
                  title, artist_name, album_name, rel_path
                );
                "#,
            )?;
        }

        // Studio metadata columns (additive, idempotent).
        for (table, col, decl) in [
            ("albums", "release_date", "TEXT"),
            ("albums", "genre", "TEXT"),
            ("albums", "label", "TEXT"),
            ("albums", "country", "TEXT"),
            ("albums", "musicbrainz_release_id", "TEXT"),
            ("albums", "discogs_release_id", "TEXT"),
            ("albums", "has_album_meta", "INTEGER NOT NULL DEFAULT 0"),
            ("albums", "expected_track_count", "INTEGER"),
            ("tracks", "genre", "TEXT"),
            ("tracks", "release_date", "TEXT"),
            ("tracks", "disc_number", "INTEGER"),
            ("tracks", "source", "TEXT"),
            ("tracks", "url", "TEXT"),
            ("tracks", "lyrics", "TEXT"),
        ] {
            let exists: bool = conn
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |r| r.get::<_, String>(1))?
                .filter_map(|r| r.ok())
                .any(|name| name == col);
            if !exists {
                conn.execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    /// Add `account_id` to favorites/playlists; assign existing rows to `default`.
    fn migrate_user_data_account_id(conn: &Connection) -> Result<()> {
        let fav_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='favorites'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let fav_needs = fav_sql
            .as_deref()
            .map(|s| !s.to_ascii_lowercase().contains("account_id"))
            .unwrap_or(false);
        if fav_needs {
            conn.execute_batch(
                r#"
                CREATE TABLE favorites_v2 (
                  account_id TEXT NOT NULL,
                  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (account_id, track_id)
                );
                INSERT INTO favorites_v2(account_id, track_id, created_at)
                  SELECT 'default', track_id, created_at FROM favorites;
                DROP TABLE favorites;
                ALTER TABLE favorites_v2 RENAME TO favorites;
                "#,
            )?;
        }

        let pl_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='playlists'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let pl_needs = pl_sql
            .as_deref()
            .map(|s| !s.to_ascii_lowercase().contains("account_id"))
            .unwrap_or(false);
        if pl_needs {
            // playlist_tracks FK → playlists; disable briefly for table rebuild.
            conn.execute_batch(
                r#"
                PRAGMA foreign_keys = OFF;
                CREATE TABLE playlists_v2 (
                  id TEXT PRIMARY KEY,
                  account_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                INSERT INTO playlists_v2(id, account_id, name, created_at)
                  SELECT id, 'default', name, created_at FROM playlists;
                DROP TABLE playlists;
                ALTER TABLE playlists_v2 RENAME TO playlists;
                PRAGMA foreign_keys = ON;
                "#,
            )?;
        }
        Ok(())
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    /// Snapshot favorites/playlist membership by rel_path before catalog wipe.
    pub fn snapshot_user_links(&self) -> Result<UserLinkSnapshot> {
        let conn = self.conn.lock().unwrap();
        let mut favs = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT f.account_id, t.rel_path FROM favorites f JOIN tracks t ON t.id = f.track_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
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

    pub fn restore_user_links(&self, snap: &UserLinkSnapshot) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        for (account_id, rel) in &snap.favorite_rel_paths {
            if let Some(id) = self.track_id_by_rel(rel)? {
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
                    params![account_id, id, now],
                )?;
            }
        }
        for (playlist_id, rel, position) in &snap.playlist_tracks {
            if let Some(id) = self.track_id_by_rel(rel)? {
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
                    params![playlist_id, id, position],
                )?;
            }
        }
        Ok(())
    }

    pub fn track_id_by_rel(&self, rel: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let id = conn
            .query_row(
                "SELECT id FROM tracks WHERE rel_path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .optional()?;
        Ok(id)
    }

    /// Wipe FS catalog only (playlists rows kept; membership restored via snapshot).
    pub fn clear_catalog(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
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
        Ok(())
    }

    pub fn upsert_artist(&self, name: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
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

    pub fn upsert_album(
        &self,
        name: &str,
        artist_name: &str,
        artist_id: Option<i64>,
        folder_key: &str,
        cover_path: Option<&Path>,
        loose: bool,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let cover = cover_path.map(|p| p.to_string_lossy().into_owned());
        let has_cover = cover.is_some();
        conn.execute(
            r#"
            INSERT INTO albums(name, artist_name, artist_id, folder_key, cover_path, has_cover, loose)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(folder_key) DO UPDATE SET
              name=excluded.name,
              artist_name=excluded.artist_name,
              artist_id=COALESCE(excluded.artist_id, albums.artist_id),
              cover_path=excluded.cover_path,
              has_cover=excluded.has_cover,
              loose=excluded.loose
            "#,
            params![
                name,
                artist_name,
                artist_id,
                folder_key,
                cover,
                has_cover as i64,
                loose as i64
            ],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM albums WHERE folder_key = ?1",
            params![folder_key],
            |r| r.get(0),
        )?;
        Ok(id)
    }

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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO tracks(
              rel_path, file_path, album_id, artist_id, title, artist_name, album_name,
              duration_ms, track_number, size, mtime, genre, release_date, lyrics
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
            ON CONFLICT(rel_path) DO UPDATE SET
              file_path=excluded.file_path,
              album_id=excluded.album_id,
              artist_id=excluded.artist_id,
              title=excluded.title,
              artist_name=excluded.artist_name,
              album_name=excluded.album_name,
              duration_ms=excluded.duration_ms,
              track_number=excluded.track_number,
              size=excluded.size,
              mtime=excluded.mtime,
              genre=COALESCE(excluded.genre, tracks.genre),
              release_date=COALESCE(excluded.release_date, tracks.release_date),
              lyrics=COALESCE(excluded.lyrics, tracks.lyrics)
            "#,
            params![
                rel_path,
                file_path.to_string_lossy().as_ref(),
                album_id,
                artist_id,
                title,
                artist_name,
                album_name,
                duration_ms,
                track_number,
                size as i64,
                mtime,
                genre,
                release_date,
                lyrics
            ],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tracks WHERE rel_path = ?1",
            params![rel_path],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO files(rel_path, size, mtime) VALUES (?1,?2,?3)
             ON CONFLICT(rel_path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime",
            params![rel_path, size as i64, mtime],
        )?;
        Ok(id)
    }

    pub fn rebuild_fts(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM tracks_fts;
            INSERT INTO tracks_fts(rowid, title, artist_name, album_name, rel_path)
              SELECT id, title, artist_name, album_name, rel_path FROM tracks;
            "#,
        )?;
        Ok(())
    }

    pub fn refresh_counts(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            UPDATE albums SET track_count = (
              SELECT COUNT(*) FROM tracks t WHERE t.album_id = albums.id
            );
            UPDATE artists SET
              track_count = (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = artists.id),
              album_count = (SELECT COUNT(*) FROM albums a WHERE a.artist_id = artists.id);
            "#,
        )?;
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO library_meta(key, value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let track_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        let album_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))?;
        let artist_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))?;
        let last_scan_at = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'last_scan_at'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(LibraryStats {
            track_count,
            album_count,
            artist_count,
            music_root,
            last_scan_at,
            scanning: false,
            disk_total_bytes: None,
            disk_available_bytes: None,
        })
    }

    const TRACK_COLS: &'static str = "id, rel_path, title, artist_name, album_name, duration_ms, \
         track_number, album_id, artist_id, genre, release_date, lyrics";
    const TRACK_COLS_T: &'static str = "t.id, t.rel_path, t.title, t.artist_name, t.album_name, t.duration_ms, \
         t.track_number, t.album_id, t.artist_id, t.genre, t.release_date, t.lyrics";

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
            genre: row.get::<_, Option<String>>(9)?.filter(|s| !s.trim().is_empty()),
            release_date: row
                .get::<_, Option<String>>(10)?
                .filter(|s| !s.trim().is_empty()),
            lyrics: row.get::<_, Option<String>>(11)?.filter(|s| !s.trim().is_empty()),
        })
    }

    fn map_album(row: &rusqlite::Row<'_>) -> rusqlite::Result<Album> {
        Ok(Album {
            id: row.get(0)?,
            name: row.get(1)?,
            artist_name: row.get(2)?,
            track_count: row.get(3)?,
            artist_id: row.get(4)?,
            folder_key: row.get(5)?,
            has_cover: row.get::<_, i64>(6)? != 0,
            loose: row.get::<_, i64>(7)? != 0,
            genre: row.get::<_, Option<String>>(8)?.filter(|s| !s.trim().is_empty()),
            release_date: row
                .get::<_, Option<String>>(9)?
                .filter(|s| !s.trim().is_empty()),
            label: row.get::<_, Option<String>>(10)?.filter(|s| !s.trim().is_empty()),
            expected_track_count: row.get(11)?,
        })
    }

    const ALBUM_COLS: &'static str = "id, name, artist_name, track_count, artist_id, folder_key, \
         has_cover, loose, genre, release_date, label, expected_track_count";

    pub fn album_cover_path(&self, album_id: i64) -> Result<Option<PathBuf>> {
        let conn = self.conn.lock().unwrap();
        let p: Option<Option<String>> = conn
            .query_row(
                "SELECT cover_path FROM albums WHERE id = ?1 AND has_cover = 1",
                params![album_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.flatten().map(PathBuf::from))
    }

    pub fn artist_cover_path(&self, artist_id: i64) -> Result<Option<PathBuf>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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

    pub fn search_tracks(&self, q: &str, limit: i64) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{q}%");
        let sql = format!(
            "SELECT {} FROM tracks
             WHERE title LIKE ?1 OR artist_name LIKE ?1 OR album_name LIKE ?1
                OR rel_path LIKE ?1 OR IFNULL(genre,'') LIKE ?1
             ORDER BY title COLLATE NOCASE
             LIMIT ?2",
            Self::TRACK_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pattern, limit], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM tracks WHERE id = ?1", Self::TRACK_COLS);
        let t = conn
            .query_row(&sql, params![id], Self::map_track)
            .optional()?;
        Ok(t)
    }

    pub fn track_file_path(&self, id: i64) -> Result<Option<PathBuf>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let p: Option<String> = conn
            .query_row(
                "SELECT file_path FROM tracks WHERE rel_path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .optional()?;
        Ok(p.map(PathBuf::from))
    }

    pub fn list_albums(&self) -> Result<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM albums ORDER BY artist_name COLLATE NOCASE, name COLLATE NOCASE",
            Self::ALBUM_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::map_album)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn album_tracks(&self, album_id: i64) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM tracks WHERE album_id = ?1", Self::TRACK_COLS);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![album_id], Self::map_track)?;
        let mut tracks: Vec<Track> = rows.filter_map(|r| r.ok()).collect();
        // Parity with old RE-KORD: order by on-disk filename (numeric), not ID3 track_number.
        tracks.sort_by(|a, b| {
            let fa = a.rel_path.rsplit('/').next().unwrap_or(a.rel_path.as_str());
            let fb = b.rel_path.rsplit('/').next().unwrap_or(b.rel_path.as_str());
            nat_cmp(fa, fb).then_with(|| a.rel_path.cmp(&b.rel_path))
        });
        Ok(tracks)
    }

    pub fn list_artists(&self) -> Result<Vec<Artist>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM albums WHERE id = ?1", Self::ALBUM_COLS);
        let a = conn
            .query_row(&sql, params![id], Self::map_album)
            .optional()?;
        Ok(a)
    }

    pub fn list_favorites(&self, account_id: &str) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM favorites f
             JOIN tracks t ON t.id = f.track_id
             WHERE f.account_id = ?1
             ORDER BY f.created_at DESC",
            Self::TRACK_COLS_T
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![account_id], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn add_favorite(&self, account_id: &str, track_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
            params![account_id, track_id, now],
        )?;
        Ok(())
    }

    pub fn remove_favorite(&self, account_id: &str, track_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM favorites WHERE account_id = ?1 AND track_id = ?2",
            params![account_id, track_id],
        )?;
        Ok(())
    }

    pub fn export_favorite_rel_paths(&self, account_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT t.rel_path FROM favorites f
            JOIN tracks t ON t.id = f.track_id
            WHERE f.account_id = ?1
            ORDER BY f.created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![account_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Distinct account ids that own favorites or playlists.
    pub fn list_user_data_account_ids(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut ids = std::collections::BTreeSet::new();
        {
            let mut stmt = conn.prepare("SELECT DISTINCT account_id FROM favorites")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                ids.insert(row);
            }
        }
        {
            let mut stmt = conn.prepare("SELECT DISTINCT account_id FROM playlists")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                ids.insert(row);
            }
        }
        Ok(ids.into_iter().collect())
    }

    /// Replace favorites for one account from stable rel_path keys.
    pub fn replace_favorites_by_rel_paths(
        &self,
        account_id: &str,
        paths: &[String],
    ) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut linked = 0u32;
        for rel in paths {
            let id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM tracks WHERE rel_path = ?1",
                    params![rel],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = id {
                conn.execute(
                    "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
                    params![account_id, id, now],
                )?;
                linked += 1;
            }
        }
        Ok(linked)
    }

    pub fn export_playlists_backup(&self, account_id: &str) -> Result<Vec<PlaylistBackup>> {
        let playlists = self.list_playlists(account_id)?;
        let mut out = Vec::with_capacity(playlists.len());
        for pl in playlists {
            let tracks = self.playlist_tracks(account_id, &pl.id)?;
            out.push(PlaylistBackup {
                name: pl.name,
                tracks: tracks
                    .into_iter()
                    .map(|t| PlaylistBackupTrack {
                        rel_path: t.rel_path,
                        title: t.title,
                        artist_name: t.artist_name,
                        album_name: t.album_name,
                    })
                    .collect(),
            });
        }
        Ok(out)
    }

    /// Wipe one account's playlists and recreate from backup. Returns (playlists, tracks).
    pub fn replace_playlists_backup(
        &self,
        account_id: &str,
        playlists: &[PlaylistBackup],
    ) -> Result<(u32, u32)> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
                params![account_id],
            )?;
            conn.execute(
                "DELETE FROM playlists WHERE account_id = ?1",
                params![account_id],
            )?;
        }
        let mut pl_n = 0u32;
        let mut tr_n = 0u32;
        for pl in playlists {
            let created = self.create_playlist(account_id, &pl.name)?;
            pl_n += 1;
            for (i, row) in pl.tracks.iter().enumerate() {
                if let Some(id) = self.track_id_by_rel(&row.rel_path)? {
                    let conn = self.conn.lock().unwrap();
                    conn.execute(
                        "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
                        params![created.id, id, i as i64],
                    )?;
                    tr_n += 1;
                }
            }
        }
        Ok((pl_n, tr_n))
    }

    pub fn delete_account_user_data(&self, account_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
            params![account_id],
        )?;
        conn.execute(
            "DELETE FROM playlists WHERE account_id = ?1",
            params![account_id],
        )?;
        conn.execute(
            "DELETE FROM favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        Ok(())
    }

    pub fn list_playlists(&self, account_id: &str) -> Result<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT p.id, p.name, p.created_at,
                   (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id)
            FROM playlists p
            WHERE p.account_id = ?1
            ORDER BY p.created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok(Playlist {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                track_count: r.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn create_playlist(&self, account_id: &str, name: &str) -> Result<Playlist> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO playlists(id, account_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, account_id, name, created_at],
        )?;
        Ok(Playlist {
            id,
            name: name.to_string(),
            created_at,
            track_count: 0,
        })
    }

    fn playlist_belongs(&self, account_id: &str, playlist_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE id = ?1 AND account_id = ?2",
            params![playlist_id, account_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn delete_playlist(&self, account_id: &str, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM playlists WHERE id = ?1 AND account_id = ?2",
            params![id, account_id],
        )?;
        Ok(n > 0)
    }

    pub fn rename_playlist(&self, account_id: &str, id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE playlists SET name = ?1 WHERE id = ?2 AND account_id = ?3",
            params![name, id, account_id],
        )?;
        Ok(n > 0)
    }

    pub fn playlist_tracks(&self, account_id: &str, id: &str) -> Result<Vec<Track>> {
        if !self.playlist_belongs(account_id, id)? {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position",
            Self::TRACK_COLS_T
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![id], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn add_to_playlist(
        &self,
        account_id: &str,
        playlist_id: &str,
        track_id: i64,
    ) -> Result<()> {
        if !self.playlist_belongs(account_id, playlist_id)? {
            anyhow::bail!("playlist not found");
        }
        let conn = self.conn.lock().unwrap();
        let pos: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
            params![playlist_id, track_id, pos],
        )?;
        Ok(())
    }

    pub fn remove_from_playlist(
        &self,
        account_id: &str,
        playlist_id: &str,
        track_id: i64,
    ) -> Result<()> {
        if !self.playlist_belongs(account_id, playlist_id)? {
            anyhow::bail!("playlist not found");
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        Ok(())
    }

    pub fn track_by_rel(&self, rel: &str) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM tracks WHERE rel_path = ?1", Self::TRACK_COLS);
        let row = conn
            .query_row(&sql, params![rel], Self::map_track)
            .optional()?;
        Ok(row)
    }

    pub fn tracks_by_album_folder(&self, folder_key: &str) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM tracks t
             JOIN albums a ON a.id = t.album_id
             WHERE a.folder_key = ?1
             ORDER BY t.track_number, t.rel_path",
            Self::TRACK_COLS_T
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![folder_key], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Fill album genre/release_date from track tags when album meta is empty.
    pub fn backfill_album_meta_from_tracks(&self, album_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE albums SET
              genre = COALESCE(
                NULLIF(TRIM(genre), ''),
                (SELECT genre FROM tracks
                 WHERE album_id = albums.id AND genre IS NOT NULL AND TRIM(genre) != ''
                 LIMIT 1)
              ),
              release_date = COALESCE(
                NULLIF(TRIM(release_date), ''),
                (SELECT release_date FROM tracks
                 WHERE album_id = albums.id AND release_date IS NOT NULL AND TRIM(release_date) != ''
                 LIMIT 1)
              )
            WHERE id = ?1
            "#,
            params![album_id],
        )?;
        Ok(())
    }

    pub fn save_track_fields(
        &self,
        rel_path: &str,
        title: Option<&str>,
        genre: Option<&str>,
        release_date: Option<&str>,
        lyrics: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE tracks SET
              title = COALESCE(?2, title),
              genre = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE genre END,
              release_date = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE release_date END,
              lyrics = CASE WHEN ?5 IS NOT NULL THEN ?5 ELSE lyrics END
            WHERE rel_path = ?1
            "#,
            params![rel_path, title, genre, release_date, lyrics],
        )?;
        Ok(())
    }

    pub fn save_album_fields(
        &self,
        folder_key: &str,
        name: Option<&str>,
        genre: Option<&str>,
        release_date: Option<&str>,
        label: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE albums SET
              name = COALESCE(?2, name),
              genre = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE genre END,
              release_date = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE release_date END,
              label = CASE WHEN ?5 IS NOT NULL THEN ?5 ELSE label END,
              has_album_meta = 1
            WHERE folder_key = ?1
            "#,
            params![folder_key, name, genre, release_date, label],
        )?;
        Ok(())
    }

    pub fn delete_track_by_rel(&self, rel_path: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM tracks WHERE rel_path = ?1", params![rel_path])?;
        let _ = conn.execute("DELETE FROM files WHERE rel_path = ?1", params![rel_path]);
        Ok(n > 0)
    }

    pub fn delete_album_by_folder(&self, folder_key: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
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
        conn.execute("DELETE FROM tracks WHERE album_id = ?1", params![id])?;
        let n = conn.execute("DELETE FROM albums WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn apply_album_meta(
        &self,
        folder_key: &str,
        meta: &crate::metadata::providers::FetchedAlbumMeta,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE albums SET
              release_date = COALESCE(?2, release_date),
              genre = COALESCE(?3, genre),
              label = COALESCE(?4, label),
              country = COALESCE(?5, country),
              musicbrainz_release_id = COALESCE(?6, musicbrainz_release_id),
              discogs_release_id = COALESCE(?7, discogs_release_id),
              expected_track_count = COALESCE(?8, expected_track_count),
              has_album_meta = 1,
              name = COALESCE(?9, name)
            WHERE folder_key = ?1
            "#,
            params![
                folder_key,
                meta.release_date,
                meta.genre,
                meta.label,
                meta.country,
                meta.musicbrainz_release_id,
                meta.discogs_release_id,
                meta.expected_track_count,
                meta.title,
            ],
        )?;
        Ok(())
    }

    pub fn set_album_tracks_genre(&self, folder_key: &str, genre: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE tracks SET genre = ?2
            WHERE album_id = (SELECT id FROM albums WHERE folder_key = ?1)
            "#,
            params![folder_key, genre],
        )?;
        Ok(())
    }

    pub fn apply_track_meta(
        &self,
        rel_path: &str,
        meta: &crate::metadata::providers::FetchedTrackMeta,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            UPDATE tracks SET
              title = COALESCE(?2, title),
              genre = COALESCE(?3, genre),
              release_date = COALESCE(?4, release_date),
              track_number = COALESCE(?5, track_number),
              disc_number = COALESCE(?6, disc_number),
              source = COALESCE(?7, source),
              url = COALESCE(?8, url),
              lyrics = COALESCE(?9, lyrics)
            WHERE rel_path = ?1
            "#,
            params![
                rel_path,
                meta.title,
                meta.genre,
                meta.release_date,
                meta.track_number,
                meta.disc_number,
                meta.source,
                meta.url,
                meta.lyrics,
            ],
        )?;
        Ok(())
    }

    pub fn set_album_cover_path(&self, folder_key: &str, cover: &Path) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let cover_s = cover.to_string_lossy().into_owned();
        conn.execute(
            r#"
            UPDATE albums SET cover_path = ?2, has_cover = 1
            WHERE folder_key = ?1
            "#,
            params![folder_key, cover_s],
        )?;
        Ok(())
    }

    pub fn all_album_folder_keys(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT folder_key FROM albums")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

/// Numeric-aware string compare (parity with JS localeCompare numeric).
fn nat_cmp(a: &str, b: &str) -> std::cmp::Ordering {
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
                let al = ac.to_ascii_lowercase();
                let bl = bc.to_ascii_lowercase();
                match al.cmp(&bl) {
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
