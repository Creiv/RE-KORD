import { artworkUrl, coverUrlForAlbumRelPath, coverUrlForTrackRelPath } from "./api"
import type { EnrichedTrack, LibraryAlbumIndex } from "../types"

export type AlbumArtworkRef = Pick<
  LibraryAlbumIndex,
  "coverArtId" | "updatedAt" | "coverRelPath"
>

export type CoverDisplay = {
  src: string
  /** URL di riserva se la cache artwork non risponde (cover su disco). */
  fallbackSrc?: string
  version: number | null
}

export function trackCoverDisplay(
  track: Pick<EnrichedTrack, "relPath" | "updatedAt">,
  album?: AlbumArtworkRef | null,
  artworkSize: "128" | "256" | "full" = "128",
): CoverDisplay {
  const artId = album?.coverArtId?.trim()
  const coverRel = album?.coverRelPath?.trim()
  if (artId) {
    return {
      src: artworkUrl(artId, artworkSize),
      fallbackSrc: coverRel
        ? coverUrlForAlbumRelPath(coverRel)
        : coverUrlForTrackRelPath(track.relPath),
      version: album?.updatedAt ?? null,
    }
  }
  const version =
    Math.max(Number(track.updatedAt) || 0, Number(album?.updatedAt) || 0) ||
    null
  return { src: coverUrlForTrackRelPath(track.relPath), version }
}
