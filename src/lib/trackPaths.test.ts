// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  albumFolderFromTrack,
  albumFolderFromTrackRelPath,
} from "../../src/lib/trackPaths"

describe("trackPaths", () => {
  it("albumFolderFromTrackRelPath uses albumFolderRelPath when set", () => {
    expect(
      albumFolderFromTrackRelPath("Artist/Tracks/song.mp3", {
        albumFolderRelPath: "Artist",
      }),
    ).toBe("Artist")
  })

  it("albumFolderFromTrackRelPath derives from filePath for loose Tracks", () => {
    expect(
      albumFolderFromTrackRelPath("Artist/Tracks/song.mp3", {
        filePath: "Artist/song.mp3",
      }),
    ).toBe("Artist")
  })

  it("albumFolderFromTrackRelPath supports legacy Tracce segment", () => {
    expect(
      albumFolderFromTrackRelPath("Artist/Tracce/song.mp3", {
        filePath: "Artist/song.mp3",
      }),
    ).toBe("Artist")
  })

  it("albumFolderFromTrackRelPath uses parent of relPath for normal albums", () => {
    expect(albumFolderFromTrackRelPath("Artist/Album/song.mp3")).toBe(
      "Artist/Album",
    )
  })

  it("albumFolderFromTrack prefers albumFolderRelPath", () => {
    expect(
      albumFolderFromTrack({
        relPath: "Artist/Tracks/song.mp3",
        filePath: "Artist/song.mp3",
        albumFolderRelPath: "Artist",
      }),
    ).toBe("Artist")
  })
})
