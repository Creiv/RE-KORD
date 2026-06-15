import fs from "fs"
import path from "path"
import Database from "better-sqlite3"
import { ensureRekordSchemaFile, rekordBaseDir } from "../rekordDataStore.mjs"
import { rekordArtworkDir, rekordDbPath } from "./paths.mjs"
import { MIGRATION_SQL, SCHEMA_VERSION } from "./schema.mjs"

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
  if (!row) {
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(SCHEMA_VERSION)
  } else if (row.version < SCHEMA_VERSION) {
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(SCHEMA_VERSION)
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
