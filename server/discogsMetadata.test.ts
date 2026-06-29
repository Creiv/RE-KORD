import { describe, expect, it } from "vitest"
import {
  mergeReleaseMetadata,
  normalizeDiscogsRelease,
  parseDiscogsDurationMs,
  scoreDiscogsCandidate,
} from "./discogsMetadata.mjs"

describe("discogsMetadata", () => {
  it("parses mm:ss durations", () => {
    expect(parseDiscogsDurationMs("3:32")).toBe(212000)
    expect(parseDiscogsDurationMs("1:02:03")).toBe(3723000)
  })

  it("scores album releases above interviews", () => {
    const album = scoreDiscogsCandidate(
      {
        type: "release",
        title: "Nirvana - Nevermind",
        artist: "Nirvana",
        year: "1991",
        format: ["CD", "Album"],
      },
      "Nirvana",
      "Nevermind",
    )
    const dvd = scoreDiscogsCandidate(
      {
        type: "release",
        title: "Nirvana - Nevermind",
        artist: "Nirvana",
        format: ["DVD", "Interview"],
      },
      "Nirvana",
      "Nevermind",
    )
    expect(album).toBeGreaterThan(dvd)
  })

  it("normalizes release payload", () => {
    const out = normalizeDiscogsRelease(
      {
        id: 123,
        title: "Test Album",
        year: 2020,
        country: "Italy",
        uri: "https://www.discogs.com/release/123",
        artists: [{ id: 9, name: "Artist" }],
        labels: [{ name: "Label X", catno: "CAT-1" }],
        genres: ["Rock"],
        styles: ["Grunge"],
        formats: [{ name: "Vinyl", descriptions: ["LP"], qty: "1" }],
        tracklist: [{ type_: "track", position: "1", title: "One", duration: "3:00" }],
        community: { have: 10, want: 2, rating: { average: 4.2, count: 5 } },
      },
      { lowest_price: { value: 12.5, currency: "EUR" }, num_for_sale: 3 },
    )
    expect(out.ok).toBe(true)
    expect(out.discogsReleaseId).toBe(123)
    expect(out.label).toBe("Label X")
    expect(out.genre).toContain("Rock")
    expect(out.expectedTracks?.[0]?.title).toBe("One")
    expect(out.discogsExtra?.marketplace?.lowestPrice).toBe(12.5)
  })

  it("merges missing fields from fallback", () => {
    const merged = mergeReleaseMetadata(
      {
        ok: true,
        source: "discogs",
        label: "Discogs Label",
        releaseDate: null,
        musicbrainzReleaseId: null,
      },
      {
        ok: true,
        source: "musicbrainz",
        releaseDate: "1991",
        musicbrainzReleaseId: "mb-1",
      },
    )
    expect(merged.releaseDate).toBe("1991")
    expect(merged.musicbrainzReleaseId).toBe("mb-1")
    expect(merged.label).toBe("Discogs Label")
  })
})
