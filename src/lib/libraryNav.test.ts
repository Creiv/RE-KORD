import { describe, expect, it } from "vitest"
import {
  artistHasOnlyLooseAlbum,
  formatTrackByline,
  isLooseTrack,
  openArtistInLibrary,
  resolveTrackFromLibrary,
} from "./libraryNav"
import type { LibraryIndex } from "../types"

const looseIndex = {
  artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 2 }],
  albums: [
    {
      id: "Artist::Tracks",
      artistId: "Artist",
      artist: "Artist",
      name: "Tracks",
      relPath: "Artist",
      trackCount: 2,
      loose: true,
      tracks: ["Artist/Tracks/a.mp3", "Artist/Tracks/b.mp3"],
    },
  ],
  tracks: [
    {
      id: "Artist/Tracks/a.mp3",
      relPath: "Artist/Tracks/a.mp3",
      filePath: "Artist/a.mp3",
      title: "A",
      artist: "Artist",
      album: "Tracks",
      albumId: "Artist::Tracks",
      loose: true,
    },
    {
      id: "Artist/Tracks/b.mp3",
      relPath: "Artist/Tracks/b.mp3",
      filePath: "Artist/b.mp3",
      title: "B",
      artist: "Artist",
      album: "Tracks",
      albumId: "Artist::Tracks",
      loose: true,
    },
  ],
} as unknown as LibraryIndex

describe("libraryNav", () => {
  it("detects loose-only artists", () => {
    expect(artistHasOnlyLooseAlbum(looseIndex, "Artist")).toBe(true)
  })

  it("formats loose track byline without album label", () => {
    expect(
      formatTrackByline({
        relPath: "Artist/Tracks/a.mp3",
        title: "A",
        artist: "Artist",
        album: "Tracks",
      }),
    ).toBe("Artist")
    expect(isLooseTrack({ relPath: "Artist/Tracks/a.mp3", album: "Tracks" })).toBe(
      true,
    )
  })

  it("openArtistInLibrary jumps to album when only loose", () => {
    const calls: string[] = []
    openArtistInLibrary(
      looseIndex,
      "Artist",
      (id) => calls.push(`artist:${id}`),
      (artist, album) => calls.push(`album:${artist}/${album}`),
    )
    expect(calls).toEqual(["album:Artist/Tracks"])
  })

  it("resolveTrackFromLibrary matches legacy Tracce rel paths", () => {
    const full = resolveTrackFromLibrary(
      {
        relPath: "Artist/Tracce/a.mp3",
        title: "A",
        artist: "Artist",
        album: "Tracce",
      },
      looseIndex.tracks,
    )
    expect(full.filePath).toBe("Artist/a.mp3")
    expect(full.relPath).toBe("Artist/Tracks/a.mp3")
  })
})
