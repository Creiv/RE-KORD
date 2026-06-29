import { existsSync, readdirSync } from "fs"
import path from "path"
import {
  saveAlbumFetchedMeta,
  saveTrackFetchedMeta,
  prepareTrackTitleForMeta,
} from "./albumInfo.mjs"
import { fetchDiscogsRelease } from "./discogsMetadata.mjs"
import { matchTrackToDiscogsEntry } from "./discogsTrackMatch.mjs"
import { saveTrackMetaToDb } from "./db/queries/metadata.mjs"
import { isAudioFile } from "./musicLibrary.mjs"
import { getMusicRoot } from "./musicRootConfig.mjs"
import { isLibraryDbBootstrapped } from "./db/index.mjs"

/**
 * @param {string} albumDir absolute path
 * @param {Record<string, unknown>} meta normalized discogs release
 */
export async function enrichTracksFromDiscogsTracklist(albumDir, meta) {
  const tracklist = Array.isArray(meta?.expectedTracks) ? meta.expectedTracks : []
  if (!tracklist.length) return []

  const parts = albumDir.split(path.sep)
  const artist = parts[parts.length - 2] || ""
  const discogsUri = meta.discogsUri || meta.discogsExtra?.discogsUri || null
  const deltas = []

  let files = []
  try {
    files = readdirSync(albumDir).filter((f) => isAudioFile(path.join(albumDir, f)))
  } catch {
    return []
  }

  const root = getMusicRoot()
  const folderRel = path.relative(root, albumDir).replace(/\\/g, "/")
  const useDb = isLibraryDbBootstrapped(root)

  for (const fileName of files) {
    const titleRaw = fileName.replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "")
    const titlePrepared = prepareTrackTitleForMeta(artist, titleRaw) || titleRaw
    const hit = matchTrackToDiscogsEntry(
      fileName,
      titleRaw,
      artist,
      tracklist,
      titlePrepared,
    )
    if (!hit) continue

    const patch = {
      source: "discogs",
      fetchedAt: new Date().toISOString(),
    }
    if (discogsUri) patch.url = discogsUri
    if (Number.isFinite(Number(hit.row.position))) {
      patch.trackNumber = Number(hit.row.position)
    } else {
      patch.trackNumber = hit.index + 1
    }
    if (Number.isFinite(Number(hit.row.durationMs)) && hit.row.durationMs > 0) {
      patch.durationMs = hit.row.durationMs
    }

    if (useDb) {
      const relPath = `${folderRel}/${fileName}`.replace(/\\/g, "/")
      saveTrackMetaToDb(root, relPath, patch)
      deltas.push({ relPath, ...patch })
    } else {
      await saveTrackFetchedMeta(albumDir, fileName, patch)
      deltas.push({ relPath: `${folderRel}/${fileName}`, ...patch })
    }
  }

  return deltas
}

/**
 * @param {string} albumDir absolute album folder
 * @param {number} releaseId
 */
export async function applyDiscogsReleaseToAlbum(albumDir, releaseId) {
  const meta = await fetchDiscogsRelease(releaseId)
  if (!meta.ok) {
    const err = new Error(meta.error || "Discogs release fetch failed")
    throw err
  }
  const payload = {
    ...meta,
    releaseDate: meta.releaseDate || meta.date || null,
    fetchedAt: new Date().toISOString(),
  }
  delete payload.error
  const savedMeta = await saveAlbumFetchedMeta(albumDir, payload)
  const trackDeltas = await enrichTracksFromDiscogsTracklist(albumDir, meta)
  return { savedMeta, trackDeltas, meta }
}
