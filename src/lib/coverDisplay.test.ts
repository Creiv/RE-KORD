import { describe, expect, it } from "vitest"
import { trackCoverDisplay } from "./coverDisplay"

describe("trackCoverDisplay", () => {
  it("usa artwork cache SQLite quando l'album ha coverArtId", () => {
    const out = trackCoverDisplay(
      { relPath: "A/B/01.flac", updatedAt: 100 },
      { coverArtId: "art-1", updatedAt: 9_000, coverRelPath: "A/B/cover.jpg" },
    )
    expect(out.src).toContain("/api/library/artwork/art-1")
    expect(out.version).toBe(9_000)
  })

  it("usa /api/cover con versione max track/album senza coverArtId", () => {
    const out = trackCoverDisplay(
      { relPath: "A/B/01.flac", updatedAt: 100 },
      { coverArtId: null, updatedAt: 9_000, coverRelPath: "A/B/cover.jpg" },
    )
    expect(out.src).toContain("/api/cover")
    expect(out.version).toBe(9_000)
  })
})
