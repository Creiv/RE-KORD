//! Ordered, transactional schema migrations keyed on `PRAGMA user_version`.
//!
//! Version 1 is the *baseline*: it brings any database created before versioning
//! existed (every shape the hub has shipped so far) to the current layout by
//! inspecting what is there, so it is idempotent and safe on an already-current
//! DB. Every later step is plain, ordered SQL that runs exactly once.
//!
//! Each step runs inside one transaction together with the `user_version` bump,
//! with foreign keys disabled around it (SQLite ignores `PRAGMA foreign_keys`
//! inside a transaction, and table rebuilds need it off).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use tracing::{info, warn};

type Step = fn(&Transaction<'_>) -> Result<()>;

/// `(version, name, step)` in ascending order. Never edit a shipped step: add a new one.
const MIGRATIONS: &[(i64, &str, Step)] = &[
    (1, "baseline", v1_baseline),
    (2, "parked user links", v2_parked_user_links),
    (3, "track bpm", v3_track_bpm),
    (
        4,
        "display titles, curated fields, genres",
        v4_display_model,
    ),
    (5, "recount mp3 durations", v5_recount_mp3_durations),
    (6, "podcast sources", v6_podcast_sources),
    (7, "embedded tags and covers", v7_embedded_tags),
    (8, "query indexes", v8_query_indexes),
];

/// Schema version this build writes.
pub const SCHEMA_VERSION: i64 = 8;

pub fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Apply every pending migration in order.
pub fn run(conn: &mut Connection) -> Result<()> {
    let current = user_version(conn)?;
    if current > SCHEMA_VERSION {
        // A newer build already migrated this file. Steps are additive, so keep
        // going rather than refusing to start; just make it visible.
        warn!(
            db_version = current,
            build_version = SCHEMA_VERSION,
            "database schema is newer than this build"
        );
        return Ok(());
    }
    for (version, name, step) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let outcome = apply_step(conn, *version, *step);
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        outcome.with_context(|| format!("database migration v{version} ({name})"))?;
        info!(version, name, "database migrated");
    }
    Ok(())
}

fn apply_step(conn: &mut Connection, version: i64, step: Step) -> Result<()> {
    let tx = conn.transaction()?;
    step(&tx)?;
    report_foreign_key_violations(&tx, version)?;
    tx.pragma_update(None, "user_version", version)?;
    tx.commit()?;
    Ok(())
}

/// Rows left dangling by old builds are not worth refusing to start over; they
/// are logged (and the baseline drops the user-link orphans explicitly).
fn report_foreign_key_violations(tx: &Transaction<'_>, version: i64) -> Result<()> {
    let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    let mut count = 0u32;
    while rows.next()?.is_some() {
        count += 1;
    }
    if count > 0 {
        warn!(
            version,
            violations = count,
            "foreign key violations after migration"
        );
    }
    Ok(())
}

fn table_sql(conn: &Connection, name: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols)
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    Ok(table_columns(conn, table)?.iter().any(|c| c == col))
}

const ALBUMS_DDL: &str = r#"
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
"#;

/// Brings every pre-versioning shape to the v1 layout. Idempotent.
fn v1_baseline(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
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

    // Favorites / playlists predating multi-account: rows belong to `default`.
    if !has_column(tx, "favorites", "account_id")? {
        tx.execute_batch(
            r#"
            CREATE TABLE favorites_v2 (
              account_id TEXT NOT NULL,
              track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
              created_at TEXT NOT NULL,
              PRIMARY KEY (account_id, track_id)
            );
            INSERT OR IGNORE INTO favorites_v2(account_id, track_id, created_at)
              SELECT 'default', track_id, created_at FROM favorites;
            DROP TABLE favorites;
            ALTER TABLE favorites_v2 RENAME TO favorites;
            "#,
        )?;
    }
    if !has_column(tx, "playlists", "account_id")? {
        tx.execute_batch(
            r#"
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
            "#,
        )?;
    }

    migrate_albums_to_folder_key(tx)?;

    // Contentless FTS from early builds cannot be rebuilt in place; the index is
    // derived data (rebuilt after every scan), so recreating it loses nothing.
    let fts_ok = table_sql(tx, "tracks_fts")?
        .map(|sql| !sql.contains("content="))
        .unwrap_or(false);
    if !fts_ok {
        tx.execute_batch(
            r#"
            DROP TABLE IF EXISTS tracks_fts;
            CREATE VIRTUAL TABLE tracks_fts USING fts5(
              title, artist_name, album_name, rel_path
            );
            INSERT INTO tracks_fts(rowid, title, artist_name, album_name, rel_path)
              SELECT id, title, artist_name, album_name, rel_path FROM tracks;
            "#,
        )?;
    }

    // Studio metadata columns (additive).
    for (table, col, decl) in [
        ("albums", "release_date", "TEXT"),
        ("albums", "genre", "TEXT"),
        ("albums", "label", "TEXT"),
        ("albums", "country", "TEXT"),
        ("albums", "musicbrainz_release_id", "TEXT"),
        ("albums", "discogs_release_id", "TEXT"),
        ("albums", "discogs_extra_json", "TEXT"),
        ("albums", "has_album_meta", "INTEGER NOT NULL DEFAULT 0"),
        ("albums", "expected_track_count", "INTEGER"),
        ("tracks", "genre", "TEXT"),
        ("tracks", "release_date", "TEXT"),
        ("tracks", "disc_number", "INTEGER"),
        ("tracks", "source", "TEXT"),
        ("tracks", "url", "TEXT"),
        ("tracks", "lyrics", "TEXT"),
        ("tracks", "updated_at", "TEXT"),
    ] {
        if !has_column(tx, table, col)? {
            tx.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
        }
    }

    // Delta support: touch `updated_at` on every write and keep tombstones for
    // deleted tracks, so clients can sync without re-downloading the catalog.
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS track_tombstones (
          rel_path TEXT PRIMARY KEY,
          removed_at TEXT NOT NULL
        );

        DROP TRIGGER IF EXISTS tracks_touch_insert;
        CREATE TRIGGER tracks_touch_insert
        AFTER INSERT ON tracks BEGIN
          UPDATE tracks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = NEW.id;
          DELETE FROM track_tombstones WHERE rel_path = NEW.rel_path;
        END;

        DROP TRIGGER IF EXISTS tracks_touch_update;
        CREATE TRIGGER tracks_touch_update
        AFTER UPDATE ON tracks BEGIN
          UPDATE tracks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = NEW.id;
        END;

        DROP TRIGGER IF EXISTS tracks_tombstone;
        CREATE TRIGGER tracks_tombstone
        AFTER DELETE ON tracks BEGIN
          INSERT INTO track_tombstones(rel_path, removed_at)
            VALUES (OLD.rel_path, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(rel_path) DO UPDATE SET removed_at = excluded.removed_at;
        END;

        CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);

        UPDATE tracks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE updated_at IS NULL;

        -- Old builds rebuilt tables with foreign keys off: drop user links that
        -- point nowhere instead of carrying them forever.
        DELETE FROM favorites WHERE track_id NOT IN (SELECT id FROM tracks);
        DELETE FROM playlist_tracks
          WHERE track_id NOT IN (SELECT id FROM tracks)
             OR playlist_id NOT IN (SELECT id FROM playlists);
        "#,
    )?;
    Ok(())
}

/// Albums from before folder-first scanning had no `folder_key`. Rebuild the
/// table keeping ids (tracks point at them) and deriving the key from the
/// tracks' `<artist>/<album folder>` rel_path prefix; albums without tracks
/// cannot be keyed and are left for the next scan to recreate.
fn migrate_albums_to_folder_key(tx: &Transaction<'_>) -> Result<()> {
    let Some(sql) = table_sql(tx, "albums")? else {
        tx.execute_batch(ALBUMS_DDL)?;
        return Ok(());
    };
    if sql.contains("folder_key") {
        return Ok(());
    }
    let old_cols = table_columns(tx, "albums")?;
    tx.execute_batch("ALTER TABLE albums RENAME TO albums_pre_v1;")?;
    tx.execute_batch(ALBUMS_DDL)?;

    let pick = |col: &str, fallback: &str| -> String {
        if old_cols.iter().any(|c| c == col) {
            format!("a.{col}")
        } else {
            fallback.to_string()
        }
    };
    let insert = format!(
        r#"
        INSERT OR IGNORE INTO albums(id, artist_id, name, artist_name, folder_key, cover_path, has_cover, track_count)
        SELECT a.id, {artist_id}, {name}, {artist_name}, k.folder_key, {cover_path}, {has_cover}, 0
        FROM albums_pre_v1 a
        JOIN (
          SELECT album_id,
                 MIN(
                   CASE WHEN instr(substr(rel_path, instr(rel_path, '/') + 1), '/') > 0
                     THEN substr(rel_path, 1,
                            instr(rel_path, '/')
                            + instr(substr(rel_path, instr(rel_path, '/') + 1), '/') - 1)
                     ELSE rel_path END
                 ) AS folder_key
          FROM tracks
          WHERE album_id IS NOT NULL
          GROUP BY album_id
        ) k ON k.album_id = a.id
        "#,
        artist_id = pick("artist_id", "NULL"),
        name = pick("name", "''"),
        artist_name = pick("artist_name", "''"),
        cover_path = pick("cover_path", "NULL"),
        has_cover = pick("has_cover", "0"),
    );
    let kept = tx.execute(&insert, [])?;
    // Tracks whose album could not be carried over are re-linked by the next scan.
    tx.execute(
        "UPDATE tracks SET album_id = NULL WHERE album_id IS NOT NULL AND album_id NOT IN (SELECT id FROM albums)",
        [],
    )?;
    tx.execute_batch("DROP TABLE albums_pre_v1;")?;
    info!(kept, "albums table migrated to folder keys");
    Ok(())
}

/// Favorites / playlist entries whose file temporarily vanished (unmounted NAS,
/// a folder being moved) are parked by rel_path instead of cascading away, and
/// re-attach automatically when a track with that rel_path is inserted again.
fn v2_parked_user_links(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS parked_favorites (
          account_id TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          parked_at TEXT NOT NULL,
          PRIMARY KEY (account_id, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_parked_favorites_rel ON parked_favorites(rel_path);

        CREATE TABLE IF NOT EXISTS parked_playlist_tracks (
          playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          rel_path TEXT NOT NULL,
          position INTEGER NOT NULL,
          parked_at TEXT NOT NULL,
          PRIMARY KEY (playlist_id, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_parked_playlist_rel ON parked_playlist_tracks(rel_path);

        DROP TRIGGER IF EXISTS tracks_reattach_user_links;
        CREATE TRIGGER tracks_reattach_user_links
        AFTER INSERT ON tracks BEGIN
          INSERT OR IGNORE INTO favorites(account_id, track_id, created_at)
            SELECT account_id, NEW.id, created_at FROM parked_favorites
            WHERE rel_path = NEW.rel_path;
          DELETE FROM parked_favorites WHERE rel_path = NEW.rel_path;
          INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position)
            SELECT p.playlist_id, NEW.id, p.position FROM parked_playlist_tracks p
            WHERE p.rel_path = NEW.rel_path
              AND EXISTS (SELECT 1 FROM playlists pl WHERE pl.id = p.playlist_id);
          DELETE FROM parked_playlist_tracks WHERE rel_path = NEW.rel_path;
        END;
        "#,
    )?;
    Ok(())
}

/// Tempo from the tags (ID3 `TBPM`, Vorbis `BPM`/`TEMPO`, MP4 `tmpo`); NULL
/// until the file is (re)read by a scan.
fn v3_track_bpm(tx: &Transaction<'_>) -> Result<()> {
    if !has_column(tx, "tracks", "bpm")? {
        tx.execute_batch("ALTER TABLE tracks ADD COLUMN bpm REAL;")?;
    }
    Ok(())
}

/// Display model:
/// - `edited_fields` / `user_fields` bitmasks (see `db::field`) on albums and
///   tracks: curated values a scan must not replace with tag values, and the
///   subset a person typed (which fetches must not replace either);
/// - `added_at` / `updated_at` on albums, `added_at` on tracks;
/// - `tag_album` (album title from the tags) and normalised `genres` (JSON
///   array of canonical labels) on tracks, `genres` on albums, plus the
///   `genres` table of canonical labels;
/// - `cover_version` on albums (changes when the cover file does);
/// - `legacy_id` on playlists (legacy playlist identity for imports);
/// - FTS over title, artist, album and genres, accent-insensitive, without
///   the file path.
///
/// Every indexed file is marked stale so the next scan reads the tags again
/// (album titles and full dates were not stored before).
fn v4_display_model(tx: &Transaction<'_>) -> Result<()> {
    for (table, col, decl) in [
        ("albums", "edited_fields", "INTEGER NOT NULL DEFAULT 0"),
        ("albums", "user_fields", "INTEGER NOT NULL DEFAULT 0"),
        ("albums", "added_at", "TEXT"),
        ("albums", "updated_at", "TEXT"),
        ("albums", "genres", "TEXT"),
        ("albums", "cover_version", "TEXT"),
        ("tracks", "edited_fields", "INTEGER NOT NULL DEFAULT 0"),
        ("tracks", "user_fields", "INTEGER NOT NULL DEFAULT 0"),
        ("tracks", "added_at", "TEXT"),
        ("tracks", "tag_album", "TEXT"),
        ("tracks", "genres", "TEXT"),
        ("playlists", "legacy_id", "TEXT"),
    ] {
        if !has_column(tx, table, col)? {
            tx.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
        }
    }
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS genres (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          track_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_playlists_legacy ON playlists(account_id, legacy_id);
        CREATE INDEX IF NOT EXISTS idx_albums_updated_at ON albums(updated_at);

        UPDATE tracks SET added_at = COALESCE(added_at, updated_at,
                                              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        UPDATE albums SET
          added_at = COALESCE(added_at,
            (SELECT MIN(t.added_at) FROM tracks t WHERE t.album_id = albums.id),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at = COALESCE(updated_at,
            (SELECT MAX(t.updated_at) FROM tracks t WHERE t.album_id = albums.id),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

        DROP TRIGGER IF EXISTS tracks_touch_insert;
        CREATE TRIGGER tracks_touch_insert
        AFTER INSERT ON tracks BEGIN
          UPDATE tracks SET
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            added_at = COALESCE(NEW.added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE id = NEW.id;
          DELETE FROM track_tombstones WHERE rel_path = NEW.rel_path;
        END;

        DROP TRIGGER IF EXISTS albums_touch_insert;
        CREATE TRIGGER albums_touch_insert
        AFTER INSERT ON albums BEGIN
          UPDATE albums SET
            added_at = COALESCE(NEW.added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at = COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE id = NEW.id;
        END;

        -- Only real changes count as "updated" (scans rewrite counts every time).
        DROP TRIGGER IF EXISTS albums_touch_update;
        CREATE TRIGGER albums_touch_update
        AFTER UPDATE ON albums
        WHEN NEW.updated_at IS OLD.updated_at AND (
          NEW.name IS NOT OLD.name OR NEW.release_date IS NOT OLD.release_date
          OR NEW.genre IS NOT OLD.genre OR NEW.label IS NOT OLD.label
          OR NEW.country IS NOT OLD.country OR NEW.has_cover IS NOT OLD.has_cover
          OR NEW.cover_version IS NOT OLD.cover_version
          OR NEW.track_count IS NOT OLD.track_count
          OR NEW.expected_track_count IS NOT OLD.expected_track_count
        )
        BEGIN
          UPDATE albums SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = NEW.id;
        END;

        DROP TABLE IF EXISTS tracks_fts;
        CREATE VIRTUAL TABLE tracks_fts USING fts5(
          title, artist_name, album_name, genre,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        INSERT INTO tracks_fts(rowid, title, artist_name, album_name, genre)
          SELECT id, title, artist_name, album_name, COALESCE(genre, '') FROM tracks;

        UPDATE files SET mtime = -1;
        "#,
    )?;
    Ok(())
}

/// MP3 durations used to be bitrate estimates for VBR files without a
/// Xing/VBRI header (minutes off on long DJ sets): every MP3 is marked stale
/// so the next scan reads it again and counts its frames when needed. Such
/// files also get a synthetic Xing frame (`mp3_seek_headers`) that `/media`
/// splices into the stream, so players know the length and seek by its TOC.
fn v5_recount_mp3_durations(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mp3_seek_headers (
          rel_path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          insert_at INTEGER NOT NULL,
          frame BLOB NOT NULL
        );
        UPDATE files SET mtime = -1 WHERE lower(rel_path) LIKE '%.mp3';
        "#,
    )?;
    Ok(())
}

/// Optional "Podcast e notizie" module: the sources configured in the admin
/// panel and, per source, the metadata of its latest episodes (never audio).
/// Empty and untouched while the module is off.
fn v6_podcast_sources(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS podcast_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          name_custom INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL,
          feed_url TEXT,
          episode_count INTEGER NOT NULL DEFAULT 3,
          position INTEGER NOT NULL DEFAULT 0,
          artwork_url TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          fetched_at INTEGER,
          etag TEXT,
          last_modified TEXT,
          last_error TEXT,
          error_at INTEGER,
          episodes_json TEXT NOT NULL DEFAULT '[]'
        );
        "#,
    )?;
    Ok(())
}

/// Embedded tags and covers (5.1):
/// - tracks: track artist / album artist, track and disc totals, MusicBrainz
///   ids from the tags; `embedded_fields` (`db::field` bits whose value came
///   from the file's own tags); `tags_version` (version of the tag reader that
///   last read the file, 0 = never: the embedded-tags backfill job reads it);
/// - albums: `cover_source` (`folder`, `legacy`, `embedded`), the track an
///   embedded cover came from (`embedded_cover_from`: NULL never checked, ''
///   none found), the album artist and `embedded_fields` of the values derived
///   from the tracks' tags.
///
/// Nothing is marked stale: the existing rows keep their values and the
/// backfill job (throttled, resumable) fills what the tags add. Lyrics
/// already stored count as curated until the backfill finds the same text
/// in the file (they may come from a lyrics fetch).
fn v7_embedded_tags(tx: &Transaction<'_>) -> Result<()> {
    for (table, col, decl) in [
        ("tracks", "tag_artist", "TEXT"),
        ("tracks", "tag_album_artist", "TEXT"),
        ("tracks", "track_total", "INTEGER"),
        ("tracks", "disc_total", "INTEGER"),
        ("tracks", "mb_recording_id", "TEXT"),
        ("tracks", "mb_release_id", "TEXT"),
        ("tracks", "mb_artist_id", "TEXT"),
        ("tracks", "mb_release_group_id", "TEXT"),
        ("tracks", "embedded_fields", "INTEGER NOT NULL DEFAULT 0"),
        ("tracks", "tags_version", "INTEGER NOT NULL DEFAULT 0"),
        ("albums", "cover_source", "TEXT"),
        ("albums", "embedded_cover_from", "TEXT"),
        ("albums", "tag_album_artist", "TEXT"),
        ("albums", "embedded_fields", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !has_column(tx, table, col)? {
            tx.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
        }
    }
    tx.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_tracks_tags_version ON tracks(tags_version);
        UPDATE albums SET cover_source = CASE
            WHEN replace(cover_path, '\', '/') LIKE '%/.kord/artwork/%' THEN 'legacy'
            ELSE 'folder' END
          WHERE has_cover = 1 AND cover_path IS NOT NULL AND cover_source IS NULL;
        UPDATE tracks SET edited_fields = edited_fields | 32
          WHERE lyrics IS NOT NULL AND trim(lyrics) != '';
        "#,
    )?;
    Ok(())
}

/// Indexes for the reads the clients issue all the time, found with
/// `EXPLAIN QUERY PLAN` on a real library: albums by artist (artist pages,
/// artist covers, the per-artist subquery of the artist list) scanned the
/// whole table; the album list and the paginated track list sorted every
/// row on every page; tombstones, playlist order and favorites order used
/// temporary b-trees. The sort indexes carry the same collation as the
/// `ORDER BY` clauses, otherwise SQLite cannot use them.
fn v8_query_indexes(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
        CREATE INDEX IF NOT EXISTS idx_albums_sort
            ON albums(artist_name COLLATE NOCASE, name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_tracks_sort
            ON tracks(artist_name COLLATE NOCASE, album_name COLLATE NOCASE,
                      disc_number, track_number, title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_tombstones_removed_at ON track_tombstones(removed_at);
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position
            ON playlist_tracks(playlist_id, position);
        CREATE INDEX IF NOT EXISTS idx_favorites_created
            ON favorites(account_id, created_at);
        "#,
    )?;
    Ok(())
}
