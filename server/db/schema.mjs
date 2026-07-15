export const SCHEMA_VERSION = 8

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS library_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  last_full_scan_at TEXT,
  last_incremental_at TEXT,
  bootstrapped_at TEXT,
  music_root TEXT
);

INSERT OR IGNORE INTO library_state (id, epoch) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS files (
  rel_path TEXT PRIMARY KEY,
  size INTEGER,
  mtime_ns INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  release_date TEXT,
  cover_rel_path TEXT,
  cover_art_id TEXT,
  album_count INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER NOT NULL DEFAULT 0,
  albums_without_file_meta_count INTEGER NOT NULL DEFAULT 0,
  tracks_without_file_meta_count INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL,
  folder_rel_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  title TEXT,
  release_date TEXT,
  genre TEXT,
  label TEXT,
  country TEXT,
  musicbrainz_release_id TEXT,
  discogs_release_id INTEGER,
  discogs_extra_json TEXT,
  expected_track_count INTEGER,
  cover_rel_path TEXT,
  cover_art_id TEXT,
  has_cover INTEGER NOT NULL DEFAULT 0,
  has_album_meta INTEGER NOT NULL DEFAULT 0,
  has_track_meta INTEGER NOT NULL DEFAULT 0,
  tracks_without_file_meta_count INTEGER NOT NULL DEFAULT 0,
  loose INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER,
  updated_at INTEGER,
  user_edited INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (artist_id) REFERENCES artists(id)
);

CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_albums_folder_rel_path ON albums(folder_rel_path);
CREATE INDEX IF NOT EXISTS idx_albums_updated_at ON albums(updated_at);

CREATE TABLE IF NOT EXISTS album_expected_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id TEXT NOT NULL,
  disc INTEGER NOT NULL DEFAULT 1,
  position INTEGER,
  title TEXT NOT NULL,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_album_expected_tracks_album ON album_expected_tracks(album_id);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  file_path TEXT,
  album_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT NOT NULL,
  genre TEXT,
  release_date TEXT,
  lyrics TEXT,
  lyrics_auto_checked INTEGER NOT NULL DEFAULT 0,
  moods_json TEXT,
  duration_ms INTEGER,
  track_number INTEGER,
  disc_number INTEGER,
  source TEXT,
  url TEXT,
  file_name TEXT,
  size INTEGER,
  mtime INTEGER,
  loose INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER,
  updated_at INTEGER,
  user_edited INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_rel_path ON tracks(rel_path);
CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at);

CREATE TABLE IF NOT EXISTS artwork (
  id TEXT PRIMARY KEY,
  album_id TEXT,
  kind TEXT NOT NULL,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  full_path TEXT NOT NULL,
  thumb_128_path TEXT,
  thumb_256_path TEXT,
  updated_at INTEGER,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_artwork_album_id ON artwork(album_id);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title,
  artist_name,
  album_name,
  genre,
  rel_path UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);
`
