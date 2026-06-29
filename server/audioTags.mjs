import { parseFile } from "music-metadata"

/**
 * Legge tag audio embedded (lazy, solo su richiesta arricchimento).
 * @param {string} filePath
 * @returns {Promise<{ artist: string|null, album: string|null, title: string|null, trackNumber: number|null, genre: string|null, durationMs: number|null }|null>}
 */
export async function readAudioTags(filePath) {
  try {
    const meta = await parseFile(filePath, { duration: true })
    const common = meta.common || {}
    const artist = firstTag(common.artist, common.artists)
    const album = common.album ? String(common.album).trim() : null
    const title = common.title ? String(common.title).trim() : null
    const trackNumber = Number.isFinite(common.track?.no) ? Number(common.track.no) : null
    const genre = firstTag(common.genre, common.genres)
    const durationMs =
      Number.isFinite(meta.format?.duration) && meta.format.duration > 0
        ? Math.round(meta.format.duration * 1000)
        : null
    return { artist, album, title, trackNumber, genre, durationMs }
  } catch {
    return null
  }
}

function firstTag(single, list) {
  if (single && String(single).trim()) return String(single).trim()
  if (Array.isArray(list) && list[0]) return String(list[0]).trim()
  return null
}

/**
 * Estrae artista/titolo da pattern filename comuni.
 * @param {string} fileName
 */
export function parseFilenameTags(fileName) {
  const base = String(fileName || "")
    .replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "")
    .trim()
  if (!base) return { artist: null, title: null }
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (m) {
    return {
      artist: String(m[1]).trim() || null,
      title: String(m[2]).trim() || null,
    }
  }
  return { artist: null, title: base }
}
