import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { getLibraryDb } from "../db/index.mjs"
import { buildLibraryIndex, buildPartialIndex, isAudioFile, LIBRARY_EXCLUDE, relify } from "../musicLibrary.mjs"
import { loadLibraryLayout } from "../libraryLayout.mjs"

const EXCLUDE = LIBRARY_EXCLUDE

/**
 * @typedef {{ relPath: string, size: number, mtimeNs: number }} FsFileEntry
 */

/**
 * Walk leggero: solo stat per file audio.
 * @param {string} musicRoot
 * @returns {Promise<Map<string, FsFileEntry>>}
 */
export async function walkFilesystemStats(musicRoot) {
  const root = path.resolve(String(musicRoot || ""))
  const out = new Map()

  async function walkDir(dir, relPrefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || EXCLUDE.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walkDir(abs, rel)
        continue
      }
      if (!entry.isFile() || !isAudioFile(entry.name)) continue
      try {
        // stat async: statSync qui bloccava l'event loop per l'intero walk.
        const st = await fs.stat(abs)
        out.set(rel, {
          relPath: rel,
          size: st.size,
          mtimeNs: Math.round(st.mtimeMs * 1e6),
        })
      } catch {
        /* ok */
      }
    }
  }

  await walkDir(root, "")
  return out
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, FsFileEntry>} fsEntries
 */
export function diffAgainstFilesTable(db, fsEntries) {
  const dbRows = db.prepare("SELECT rel_path, size, mtime_ns FROM files").all()
  const dbMap = new Map(dbRows.map((r) => [r.rel_path, r]))
  const added = []
  const changed = []
  const unchanged = []

  for (const [relPath, entry] of fsEntries) {
    const prev = dbMap.get(relPath)
    if (!prev) {
      added.push(relPath)
    } else if (prev.size !== entry.size || Number(prev.mtime_ns) !== entry.mtimeNs) {
      changed.push(relPath)
    } else {
      unchanged.push(relPath)
    }
    dbMap.delete(relPath)
  }

  const removed = [...dbMap.keys()]
  return { added, changed, removed, unchanged }
}

/**
 * @param {string} musicRoot
 * @param {string} absPath
 */
export function resolveScopeFromPath(musicRoot, absPath) {
  const root = path.resolve(String(musicRoot || ""))
  const resolved = path.resolve(String(absPath || ""))
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { type: "root", scopes: [""] }
  }
  const rel = path.relative(root, resolved).replace(/\\/g, "/")
  if (!rel || rel === ".") return { type: "root", scopes: [""] }

  const parts = rel.split("/").filter(Boolean)
  if (parts.length === 1 && isAudioFile(parts[0])) {
    return { type: "root", scopes: [""] }
  }
  if (parts.length === 2 && isAudioFile(parts[1])) {
    return { type: "artist", scopes: [parts[0]] }
  }
  if (parts.length >= 2) {
    return { type: "album", scopes: [parts.slice(0, 2).join("/")] }
  }
  return { type: "artist", scopes: [parts[0]] }
}

/**
 * Risolve scope da path assoluti (watcher).
 * @param {string} musicRoot
 * @param {string[]} absPaths
 */
export function resolveScopesFromPaths(musicRoot, absPaths) {
  const scopes = new Set()
  for (const abs of absPaths) {
    const { scopes: s } = resolveScopeFromPath(musicRoot, abs)
    for (const sc of s) {
      if (sc === "") {
        scopes.add("")
      } else {
        scopes.add(sc)
      }
    }
  }
  return [...scopes]
}

/**
 * Carica durate esistenti dal DB per skip arricchimento.
 * @param {string} libraryRoot
 * @param {string[]} filePaths
 */
export function loadExistingDurations(libraryRoot, filePaths) {
  const db = getLibraryDb(libraryRoot)
  const map = new Map()
  if (!filePaths.length) return map
  const stmt = db.prepare(
    "SELECT COALESCE(file_path, rel_path) AS fp, duration_ms FROM tracks WHERE COALESCE(file_path, rel_path) = ?",
  )
  for (const fp of filePaths) {
    const row = stmt.get(fp)
    if (row?.duration_ms != null) map.set(fp, row.duration_ms)
  }
  return map
}

/**
 * @param {string} libraryRoot
 * @param {{ full?: boolean, paths?: string[], enrichDuration?: boolean, readTags?: boolean }} opts
 */
export async function runScanEngine(libraryRoot, opts = {}) {
  const root = path.resolve(String(libraryRoot || ""))
  const layout = await loadLibraryLayout(root)

  if (opts.full) {
    const index = await buildLibraryIndex(root, {
      layout,
      enrichDuration: opts.enrichDuration !== false,
      readTags: Boolean(opts.readTags),
    })
    return { mode: "full", index, removedPaths: [], stats: null }
  }

  const fsEntries = await walkFilesystemStats(root)
  const db = getLibraryDb(root)
  const diff = diffAgainstFilesTable(db, fsEntries)

  if (opts.paths?.length) {
    const scopes = resolveScopesFromPaths(root, opts.paths)
    if (scopes.some((s) => s === "")) {
      const index = await buildLibraryIndex(root, {
        layout,
        enrichDuration: opts.enrichDuration !== false,
        readTags: Boolean(opts.readTags),
      })
      return {
        mode: "incremental",
        index,
        removedPaths: diff.removed,
        stats: { scopes, root: true },
      }
    }
    const partial = await buildPartialIndex(root, scopes.filter(Boolean), {
      layout,
      enrichDuration: opts.enrichDuration !== false,
      readTags: Boolean(opts.readTags),
      existingDurations: loadExistingDurations(root, [
        ...diff.added,
        ...diff.changed,
        ...diff.unchanged,
      ]),
    })
    return {
      mode: "incremental",
      index: { musicRoot: root, ...partial },
      removedPaths: diff.removed,
      stats: {
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
        unchanged: diff.unchanged.length,
        scopes,
      },
    }
  }

  const needsWork =
    diff.added.length + diff.changed.length + diff.removed.length > 0
  if (!needsWork) {
    return { mode: "noop", index: null, removedPaths: [], stats: diff }
  }

  if (
    diff.added.length + diff.changed.length + diff.removed.length >
    Math.max(50, Math.floor(fsEntries.size * 0.25))
  ) {
    const index = await buildLibraryIndex(root, {
      layout,
      enrichDuration: opts.enrichDuration !== false,
      readTags: Boolean(opts.readTags),
      existingDurations: loadExistingDurations(root, [...diff.unchanged]),
    })
    return { mode: "full", index, removedPaths: diff.removed, stats: diff }
  }

  const scopes = new Set()
  for (const rel of [...diff.added, ...diff.changed, ...diff.removed]) {
    const { scopes: s } = resolveScopeFromPath(root, path.join(root, rel))
    for (const sc of s) scopes.add(sc)
  }

  const scopeList = [...scopes].filter(Boolean)
  if (!scopeList.length && scopes.has("")) {
    const index = await buildLibraryIndex(root, {
      layout,
      enrichDuration: opts.enrichDuration !== false,
      readTags: Boolean(opts.readTags),
      existingDurations: loadExistingDurations(root, diff.unchanged),
    })
    return {
      mode: "incremental",
      index,
      removedPaths: diff.removed,
      stats: {
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
        unchanged: diff.unchanged.length,
        scopes: [""],
      },
    }
  }
  const partial = scopeList.length
    ? await buildPartialIndex(root, scopeList, {
        layout,
        enrichDuration: opts.enrichDuration !== false,
        readTags: Boolean(opts.readTags),
        existingDurations: loadExistingDurations(root, diff.unchanged),
      })
    : { artists: [], albums: [], tracks: [], stats: null }

  return {
    mode: "incremental",
    index: { musicRoot: root, ...partial },
    removedPaths: diff.removed,
    stats: {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged.length,
      scopes: scopeList,
    },
  }
}

/**
 * Percorso media per playback (file fisico su disco).
 * @param {string} libraryRoot
 * @param {string} relPath
 */
export function resolveTrackFileRelPath(libraryRoot, relPath) {
  const db = getLibraryDb(libraryRoot)
  const row = db
    .prepare("SELECT COALESCE(file_path, rel_path) AS fp FROM tracks WHERE rel_path = ? OR file_path = ? LIMIT 1")
    .get(relPath, relPath)
  return row?.fp || relPath
}

/**
 * Cartella album reale su disco (es. loose: "Artist", non "Artist/Tracce").
 * @param {string} libraryRoot
 * @param {string} trackRelPath
 */
export function resolveAlbumFolderRelPath(libraryRoot, trackRelPath) {
  const db = getLibraryDb(libraryRoot)
  const row = db
    .prepare(
      `SELECT a.folder_rel_path
       FROM tracks t
       JOIN albums a ON a.id = t.album_id
       WHERE t.rel_path = ? OR t.file_path = ?
       LIMIT 1`,
    )
    .get(trackRelPath, trackRelPath)
  if (row?.folder_rel_path) return row.folder_rel_path
  const fileRel = resolveTrackFileRelPath(libraryRoot, trackRelPath)
  const parts = String(fileRel || "").split("/").filter(Boolean)
  if (parts.length < 2) return null
  parts.pop()
  return parts.join("/")
}
