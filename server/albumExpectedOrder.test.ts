import { describe, expect, it } from "vitest"
import { orderAlbumTrackList } from "./albumExpectedOrder.mjs"

describe("orderAlbumTrackList", () => {
  it("sorts by file name (download order), not trackNumber metadata", () => {
    const tracks = [
      {
        title: "C",
        relPath: "a/03 - third.flac",
        meta: { trackNumber: 1, fileName: "03 - third.flac" },
      },
      {
        title: "A",
        relPath: "a/01 - first.flac",
        meta: { trackNumber: 3, fileName: "01 - first.flac" },
      },
      {
        title: "B",
        relPath: "a/02 - second.flac",
        meta: { trackNumber: 2, fileName: "02 - second.flac" },
      },
    ]
    const ordered = orderAlbumTrackList(tracks)
    expect(ordered.map((t) => t.relPath)).toEqual([
      "a/01 - first.flac",
      "a/02 - second.flac",
      "a/03 - third.flac",
    ])
  })

  it("ignores expectedTracks from release metadata fetch", () => {
    const tracks = [
      { title: "03 Third Song", relPath: "Art/Alb/03.flac", meta: { fileName: "03.flac" } },
      { title: "01 First Song", relPath: "Art/Alb/01.flac", meta: { fileName: "01.flac" } },
      { title: "02 Second Song", relPath: "Art/Alb/02.flac", meta: { fileName: "02.flac" } },
    ]
    const ordered = orderAlbumTrackList(tracks)
    expect(ordered.map((t) => t.relPath)).toEqual([
      "Art/Alb/01.flac",
      "Art/Alb/02.flac",
      "Art/Alb/03.flac",
    ])
  })
})
