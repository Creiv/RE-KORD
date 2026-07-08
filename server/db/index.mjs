import fs from "fs"
import path from "path"
import Database from "better-sqlite3"
import { ensureRekordSchemaFile, rekordBaseDir } from "../rekordDataStore.mjs"
import { rekordArtworkDir, rekordDbPath } from "./paths.mjs"
import { migrateV6LoosePaths } from "./migrateV6.mjs"
import { MIGRATION_SQL } from "./schema.mjs"

/** @type {Map<string, import('better-sqlite3').Database>} */
const openDbs = new Map()

function configureDb(db) {
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
}

function runMigrations(db) {
  db.exec(MIGRATION_SQL)
  const row = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get()
  let version = row?.version ?? 0
  if (!row) {
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(1)
    version = 1
  }
  if (version < 2) {
    for (const sql of [
      "ALTER TABLE tracks ADD COLUMN replaygain_track_db REAL",
      "ALTER TABLE tracks ADD COLUMN replaygain_peak REAL",
    ]) {
      try {
        db.exec(sql)
      } catch {
        /* colonna già presente */
      }
    }
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(2)
    version = 2
  }
  if (version < 3) {
    try {
      db.exec("ALTER TABLE tracks ADD COLUMN file_path TEXT")
    } catch {
      /* colonna già presente */
    }
    try {
      db.exec("UPDATE tracks SET file_path = rel_path WHERE file_path IS NULL OR file_path = ''")
    } catch {
      /* ok */
    }
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(3)
    version = 3
  }
  if (version < 4) {
    try {
      db.exec(
        "UPDATE albums SET name = 'Tracks' WHERE loose = 1 AND name IN ('Tracce', 'Tracks')",
      )
      db.exec(
        "UPDATE tracks SET rel_path = REPLACE(rel_path, '/Tracce/', '/Tracks/') WHERE rel_path LIKE '%/Tracce/%'",
      )
      db.exec(
        "UPDATE tracks SET album_name = 'Tracks' WHERE loose = 1 AND album_name = 'Tracce'",
      )
    } catch {
      /* ok */
    }
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(4)
    version = 4
  }
  if (version < 5) {
    for (const sql of [
      "ALTER TABLE albums ADD COLUMN discogs_release_id INTEGER",
      "ALTER TABLE albums ADD COLUMN discogs_extra_json TEXT",
    ]) {
      try {
        db.exec(sql)
      } catch {
        /* colonna già presente */
      }
    }
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(5)
    version = 5
  }
  if (version < 6) {
    migrateV6LoosePaths(db)
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(6)
    version = 6
  }
  if (version < 7) {
    try {
      db.exec(
        "ALTER TABLE tracks ADD COLUMN lyrics_auto_checked INTEGER NOT NULL DEFAULT 0",
      )
    } catch {
      /* colonna già presente */
    }
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(7)
  }
}

/**
 * @param {string} libraryRoot
 * @returns {import('better-sqlite3').Database}
 */
export function getLibraryDb(libraryRoot) {
  const key = path.resolve(String(libraryRoot || ""))
  let db = openDbs.get(key)
  if (db) return db

  fs.mkdirSync(rekordBaseDir(libraryRoot), { recursive: true })
  fs.mkdirSync(rekordArtworkDir(libraryRoot), { recursive: true })
  void ensureRekordSchemaFile(libraryRoot)

  db = new Database(rekordDbPath(libraryRoot))
  configureDb(db)
  runMigrations(db)
  openDbs.set(key, db)
  return db
}

/** @param {string} libraryRoot */
export function isLibraryDbBootstrapped(libraryRoot) {
  try {
    const db = getLibraryDb(libraryRoot)
    const row = db.prepare("SELECT bootstrapped_at FROM library_state WHERE id = 1").get()
    return Boolean(row?.bootstrapped_at)
  } catch {
    return false
  }
}

/**
 * @param {string} libraryRoot
 * @param {(db: import('better-sqlite3').Database) => void} fn
 */
export function withLibraryDbTransaction(libraryRoot, fn) {
  const db = getLibraryDb(libraryRoot)
  const tx = db.transaction(() => {
    fn(db)
  })
  tx()
}

/** @param {string} libraryRoot */
export function getLibraryEpoch(libraryRoot) {
  const db = getLibraryDb(libraryRoot)
  const row = db.prepare("SELECT epoch FROM library_state WHERE id = 1").get()
  return Number(row?.epoch) || 0
}

/** @param {string} libraryRoot */
export function bumpLibraryEpoch(libraryRoot) {
  const db = getLibraryDb(libraryRoot)
  db.prepare("UPDATE library_state SET epoch = epoch + 1 WHERE id = 1").run()
  return getLibraryEpoch(libraryRoot)
}

/** @param {string} libraryRoot */
export function closeLibraryDb(libraryRoot) {
  const key = path.resolve(String(libraryRoot || ""))
  const db = openDbs.get(key)
  if (!db) return
  try {
    db.close()
  } catch {
    /* ok */
  }
  openDbs.delete(key)
}

export function closeAllLibraryDbs() {
  for (const key of [...openDbs.keys()]) {
    closeLibraryDb(key)
  }
}
