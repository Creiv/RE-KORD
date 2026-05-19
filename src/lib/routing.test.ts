import { describe, expect, it } from "vitest"
import { mergeRoute } from "./routing"

describe("mergeRoute", () => {
  const base = {
    section: "studio" as const,
    artist: null,
    album: null,
    playlist: null,
  }

  it("clears library params when leaving libreria", () => {
    const merged = mergeRoute(
      {
        section: "libreria",
        artist: "Artist",
        album: "Album",
        playlist: null,
      },
      { section: "dashboard" },
    )
    expect(merged.section).toBe("dashboard")
    expect(merged.artist).toBeNull()
    expect(merged.album).toBeNull()
  })

  it("keeps unrelated fields when switching sections", () => {
    const merged = mergeRoute(base, { section: "dashboard" })
    expect(merged.section).toBe("dashboard")
    expect(merged.playlist).toBeNull()
  })
})
