import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { atomicWriteFileUtf8, readJsonFile, rekordLibraryLayoutPath } from "./rekordDataStore.mjs"
import { readAudioTags, parseFilenameTags } from "./audioTags.mjs"

const AUDIO = /\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i
const LAYOUT_EXCLUDE = new Set([
  "kord",
  "node_modules",
  ".git",
  ".trash",
  ".wpp",
  ".rekord",
])

function isAudioFile(name) {
  return AUDIO.test(String(name || ""))
}

export const LAYOUT_SCHEMA_VERSION = 1

export const DEFAULT_LAYOUT_CONFIG = {
  schemaVersion: LAYOUT_SCHEMA_VERSION,
  preferredLayout: "artist/album/track",
  fallbacks: ["folder", "tags", "filename"],
  virtualArtist: "Varie",
  virtualAlbum: "Sconosciuto",
}

export async function loadLibraryLayout(libraryRoot) {
  const fp = rekordLibraryLayoutPath(libraryRoot)
  const raw = await readJsonFile(fp)
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT_CONFIG }
  return {
    ...DEFAULT_LAYOUT_CONFIG,
    ...raw,
    schemaVersion: Number(raw.schemaVersion) || LAYOUT_SCHEMA_VERSION,
    fallbacks: Array.isArray(raw.fallbacks)
      ? raw.fallbacks
      : DEFAULT_LAYOUT_CONFIG.fallbacks,
  }
}

export async function saveLibraryLayout(libraryRoot, config) {
  const fp = rekordLibraryLayoutPath(libraryRoot)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await atomicWriteFileUtf8(
    fp,
    JSON.stringify({ ...DEFAULT_LAYOUT_CONFIG, ...config, schemaVersion: LAYOUT_SCHEMA_VERSION }, null, 2),
  )
}

function relFromRoot(root, absPath) {
  return path.relative(root, absPath).replace(/\\/g, "/")
}

async function countAudioInDir(dir, limit = Infinity) {
  let count = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (count >= limit) break
      if (e.isFile() && isAudioFile(e.name)) count += 1
    }
  } catch {
    /* ok */
  }
  return count
}

async function sampleTags(root, samplePaths, limit = 20) {
  const tagsFound = []
  for (const rel of samplePaths.slice(0, limit)) {
    const abs = path.join(root, rel.replaceAll("/", path.sep))
    if (!existsSync(abs)) continue
    const tags = await readAudioTags(abs)
    if (tags?.artist || tags?.album || tags?.title) tagsFound.push(tags)
  }
  return tagsFound
}

/**
 * Analisi struttura cartella (setup, senza persist).
 * @param {string} musicRoot
 * @param {{ sampleLimit?: number }} opts
 */
export async function probeLibraryStructure(musicRoot, opts = {}) {
  const root = path.resolve(String(musicRoot || ""))
  const sampleLimit = Number(opts.sampleLimit) || 200
  const stats = {
    audioAtRoot: 0,
    dirsAtRoot: 0,
    dirsWithOnlyAudio: 0,
    dirsWithSubdirsAndAudio: 0,
    maxDepth: 0,
    estimatedTracks: 0,
  }
  const sampleAudioPaths = []
  const warnings = []

  let top
  try {
    top = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    return {
      stats,
      candidates: [],
      warnings: [String(err?.message || err)],
      suggestedLayout: DEFAULT_LAYOUT_CONFIG,
    }
  }

  for (const entry of top) {
    if (entry.name.startsWith(".") || LAYOUT_EXCLUDE.has(entry.name)) continue
    const full = path.join(root, entry.name)
    if (entry.isFile() && isAudioFile(entry.name)) {
      stats.audioAtRoot += 1
      stats.estimatedTracks += 1
      sampleAudioPaths.push(entry.name)
      continue
    }
    if (!entry.isDirectory()) continue
    stats.dirsAtRoot += 1
    const subs = await fs.readdir(full, { withFileTypes: true }).catch(() => [])
    const subDirs = subs.filter((s) => s.isDirectory() && !s.name.startsWith("."))
    const audioInDir = subs.filter((s) => s.isFile() && isAudioFile(s.name)).length
    if (subDirs.length && audioInDir === 0) {
      stats.dirsWithSubdirsAndAudio += 1
      stats.maxDepth = Math.max(stats.maxDepth, 2)
      for (const sub of subDirs.slice(0, 5)) {
        const n = await countAudioInDir(path.join(full, sub.name), sampleLimit)
        stats.estimatedTracks += n
        if (n > 0) sampleAudioPaths.push(`${entry.name}/${sub.name}`)
      }
    } else if (audioInDir > 0 && subDirs.length === 0) {
      stats.dirsWithOnlyAudio += 1
      stats.estimatedTracks += audioInDir
      stats.maxDepth = Math.max(stats.maxDepth, 1)
    } else if (audioInDir > 0 && subDirs.length > 0) {
      stats.dirsWithSubdirsAndAudio += 1
      stats.estimatedTracks += audioInDir
    }
    if (sampleAudioPaths.length >= sampleLimit) break
  }

  const candidates = []
  if (stats.dirsWithSubdirsAndAudio >= stats.dirsWithOnlyAudio && stats.dirsAtRoot > 0) {
    candidates.push({
      layout: "artist/album/track",
      confidence: 0.85,
      reason: "Cartelle con sottocartelle che contengono audio",
    })
  }
  if (stats.dirsWithOnlyAudio > 0) {
    candidates.push({
      layout: "artist/track",
      confidence: 0.7,
      reason: "Cartelle con file audio senza sottolivello album",
    })
  }
  if (stats.audioAtRoot > 0) {
    candidates.push({
      layout: "flat",
      confidence: 0.65,
      reason: "File audio direttamente nella root",
    })
  }

  const tagSamples = await sampleTags(root, sampleAudioPaths)
  if (tagSamples.length >= 3) {
    candidates.push({
      layout: "tags",
      confidence: 0.75,
      reason: `Tag ID3 trovati su ${tagSamples.length} file campionati`,
    })
  }

  if (!candidates.length) {
    candidates.push({
      layout: "artist/album/track",
      confidence: 0.5,
      reason: "Layout predefinito RE-KORD",
    })
  }

  candidates.sort((a, b) => b.confidence - a.confidence)
  const suggestedLayout = {
    ...DEFAULT_LAYOUT_CONFIG,
    preferredLayout: candidates[0]?.layout || "artist/album/track",
  }

  if (existsSync(path.join(root, ".kord"))) {
    warnings.push("Cartella .kord già presente — i dati esistenti saranno preservati")
  }

  return { stats, candidates, warnings, suggestedLayout }
}

/**
 * Classifica un nodo cartella per scan adattivo.
 * @param {{ entries: import('fs').Dirent[], relPath: string }} ctx
 */
export function classifyFolderNode(ctx) {
  const subs = ctx.entries.filter((e) => e.isDirectory() && !e.name.startsWith("."))
  const audioFiles = ctx.entries.filter((e) => e.isFile() && isAudioFile(e.name))
  if (!ctx.relPath) {
    if (audioFiles.length && !subs.length) return "flat"
    return "artist_root"
  }
  if (subs.length && audioFiles.length === 0) return "artist_albums"
  if (audioFiles.length && subs.length === 0) return "loose_or_album"
  if (audioFiles.length && subs.length > 0) return "mixed"
  return "empty"
}

/**
 * Risolve artista/album per file in layout non canonico.
 * @param {object} layout
 * @param {object} ctx
 */
export async function resolveTrackIdentity(layout, ctx) {
  const {
    fileName,
    filePath,
    parentRel,
    folderArtist,
    folderAlbum,
    tags,
  } = ctx
  let artist = folderArtist || null
  let album = folderAlbum || null
  let title = fileName.replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "").trim() || fileName

  const fallbacks = layout.fallbacks || DEFAULT_LAYOUT_CONFIG.fallbacks
  for (const fb of fallbacks) {
    if (fb === "folder") {
      if (folderArtist) artist = folderArtist
      if (folderAlbum) album = folderAlbum
    } else if (fb === "tags" && tags) {
      if (tags.artist) artist = tags.artist
      if (tags.album) album = tags.album
      if (tags.title) title = tags.title
    } else if (fb === "filename") {
      const parsed = parseFilenameTags(fileName)
      if (!artist && parsed.artist) artist = parsed.artist
      if (parsed.title) title = parsed.title
    }
    if (artist && album) break
  }

  if (!artist) artist = layout.virtualArtist || DEFAULT_LAYOUT_CONFIG.virtualArtist
  if (!album) album = layout.virtualAlbum || DEFAULT_LAYOUT_CONFIG.virtualAlbum

  return {
    artist,
    album,
    title,
    filePath,
    parentRel,
  }
}

/** Nome cartella logica per tracce loose nell'indice (non esiste su disco). */
export const LOOSE_ALBUM_FOLDER = "Tracks"

export function layoutAlbumFolderName(albumName, loose) {
  return loose ? LOOSE_ALBUM_FOLDER : albumName
}
