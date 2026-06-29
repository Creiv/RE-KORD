import { describe, expect, it } from "vitest"
import { matchTrackToDiscogsEntry } from "./discogsTrackMatch.mjs"

describe("discogsTrackMatch", () => {
  const tracklist = [
    { position: 1, title: "Smells Like Teen Spirit", durationMs: 301000 },
    { position: 2, title: "In Bloom", durationMs: 254000 },
  ]

  it("matches by normalized title", () => {
    const hit = matchTrackToDiscogsEntry(
      "01 Smells Like Teen Spirit.flac",
      "Smells Like Teen Spirit",
      "Nirvana",
      tracklist,
      "Smells Like Teen Spirit",
    )
    expect(hit?.row.title).toBe("Smells Like Teen Spirit")
    expect(hit?.row.position).toBe(1)
  })

  it("matches by leading track number in filename", () => {
    const hit = matchTrackToDiscogsEntry(
      "02 - In Bloom.mp3",
      "In Bloom",
      "Nirvana",
      tracklist,
      "In Bloom",
    )
    expect(hit?.row.title).toBe("In Bloom")
  })
})
