import { createContext, useContext, useEffect, type ReactNode } from "react"
import { trackCoverDisplay } from "../lib/coverDisplay"
import {
  albumArtworkForTrack,
  syncLibraryAlbumArtworkFromIndex,
} from "../lib/libraryArtworkStore"
import type { EnrichedTrack, LibraryIndex } from "../types"

const LibraryArtworkIndexContext = createContext<LibraryIndex | null>(null)

export function LibraryArtworkProvider({
  index,
  children,
}: {
  index: LibraryIndex | null
  children: ReactNode
}) {
  useEffect(() => {
    syncLibraryAlbumArtworkFromIndex(index)
  }, [index])

  return (
    <LibraryArtworkIndexContext.Provider value={index}>
      {children}
    </LibraryArtworkIndexContext.Provider>
  )
}

export function useTrackCoverDisplay(
  track: Pick<EnrichedTrack, "relPath" | "albumId" | "updatedAt">,
  artworkSize: "128" | "256" | "full" = "128",
) {
  useContext(LibraryArtworkIndexContext)
  return trackCoverDisplay(track, albumArtworkForTrack(track), artworkSize)
}
