import { describe, expect, it } from "vitest"
import { trackCoverDisplay } from "./coverDisplay"

describe("trackCoverDisplay", () => {
  it("usa artwork cache SQLite quando l'album ha coverArtId", () => {
    const out = trackCoverDisplay(
      { relPath: "A/B/01.flac", updatedAt: 100 },
      { coverArtId: "art-1", updatedAt: 9_000, coverRelPath: "A/B/cover.jpg" },
    )
    expect(out.src).toContain("/api/library/artwork/art-1")
    expect(out.fallbackSrc).toContain("/api/cover")
    expect(out.version).toBe(9_000)
  })

  it("usa filePath su disco per tracce loose senza coverArtId", () => {
    const out = trackCoverDisplay(
      {
        relPath: "Artist/Tracks/Loose.mp3",
        filePath: "Artist/Loose.mp3",
        updatedAt: 100,
      },
      null,
    )
    expect(out.src).toContain("Loose.mp3")
    expect(out.src).not.toContain("Tracks")
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
