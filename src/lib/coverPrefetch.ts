import { albumArtworkForTrack } from "./libraryArtworkStore"
import { trackCoverDisplay } from "./coverDisplay"
import type { EnrichedTrack } from "../types"

const prefetched = new Set<string>()

/** Precarica copertine dei prossimi brani in coda (best-effort). */
export function prefetchQueueCovers(
  queue: readonly EnrichedTrack[],
  currentIndex: number,
  count = 3,
): void {
  if (typeof window === "undefined") return
  for (let i = 1; i <= count; i++) {
    const tr = queue[currentIndex + i]
    if (!tr) continue
    const { src, version } = trackCoverDisplay(tr, albumArtworkForTrack(tr))
    const url = version
      ? `${src}${src.includes("?") ? "&" : "?"}v=${Math.floor(version)}`
      : src
    if (prefetched.has(url)) continue
    prefetched.add(url)
    const img = new Image()
    img.decoding = "async"
    img.src = url
  }
}
