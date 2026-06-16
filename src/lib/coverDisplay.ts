import { artworkUrl, coverUrlForTrackRelPath } from "./api"
import type { EnrichedTrack, LibraryAlbumIndex } from "../types"

export type AlbumArtworkRef = Pick<
  LibraryAlbumIndex,
  "coverArtId" | "updatedAt" | "coverRelPath"
>

export function trackCoverDisplay(
  track: Pick<EnrichedTrack, "relPath" | "updatedAt">,
  album?: AlbumArtworkRef | null,
  artworkSize: "128" | "256" | "full" = "128",
): { src: string; version: number | null } {
  const artId = album?.coverArtId?.trim()
  if (artId) {
    return {
      src: artworkUrl(artId, artworkSize),
      version: album?.updatedAt ?? null,
    }
  }
  const version =
    Math.max(Number(track.updatedAt) || 0, Number(album?.updatedAt) || 0) ||
    null
  return { src: coverUrlForTrackRelPath(track.relPath), version }
}
