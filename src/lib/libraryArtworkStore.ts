import type { LibraryIndex } from "../types"
import type { AlbumArtworkRef } from "./coverDisplay"

let albumArtById = new Map<string, AlbumArtworkRef>()

export function setLibraryAlbumArtworkMap(
  map: Map<string, AlbumArtworkRef>,
): void {
  albumArtById = map
}

export function buildAlbumArtworkMap(
  index: LibraryIndex | null,
): Map<string, AlbumArtworkRef> {
  const map = new Map<string, AlbumArtworkRef>()
  if (!index) return map
  for (const album of index.albums) {
    map.set(album.id, {
      coverArtId: album.coverArtId,
      updatedAt: album.updatedAt,
      coverRelPath: album.coverRelPath,
    })
  }
  return map
}

export function albumArtworkForTrack(track: {
  albumId?: string
}): AlbumArtworkRef | null {
  const id = String(track.albumId || "").trim()
  if (!id) return null
  return albumArtById.get(id) ?? null
}

export function syncLibraryAlbumArtworkFromIndex(
  index: LibraryIndex | null,
): void {
  setLibraryAlbumArtworkMap(buildAlbumArtworkMap(index))
}

/** Per test: stato corrente della mappa album → artwork. */
export function peekAlbumArtworkMap(): Map<string, AlbumArtworkRef> {
  return albumArtById
}
