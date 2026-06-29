import { describe, expect, it } from "vitest"
import {
  artistHasOnlyLooseAlbum,
  enrichTracksFromLibrary,
  formatTrackByline,
  isFavoriteRelPath,
  isLooseTrack,
  migrateLooseTrackPathsInUserState,
  openArtistInLibrary,
  openTrackInLibrary,
  resolveTrackAlbumName,
  resolveTrackFromLibrary,
} from "./libraryNav"
import type { LibraryIndex, UserStateV1 } from "../types"

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

  it("enrichTracksFromLibrary allinea recent stub con indice libreria", () => {
    const [enriched] = enrichTracksFromLibrary(
      [
        {
          relPath: "Artist/Tracks/a.mp3",
          title: "Stale",
          artist: "Artist",
          album: "Tracce",
        },
      ],
      looseIndex.tracks,
    )
    expect(enriched.title).toBe("A")
    expect(enriched.filePath).toBe("Artist/a.mp3")
    expect(enriched.albumId).toBe("Artist::Tracks")
  })

  it("resolveTrackAlbumName uses album index when track album is stale", () => {
    const index = {
      ...looseIndex,
      albums: [
        {
          id: "Artist::Album",
          artistId: "Artist",
          name: "New Title",
          relPath: "Artist/Album",
          trackCount: 1,
          loose: false,
          tracks: ["Artist/Album/song.mp3"],
        },
      ],
      tracks: [
        {
          id: "Artist/Album/song.mp3",
          relPath: "Artist/Album/song.mp3",
          title: "Song",
          artist: "Artist",
          album: "Old Title",
          albumId: "Artist::Album",
          albumFolderRelPath: "Artist/Album",
          loose: false,
        },
      ],
    } as unknown as LibraryIndex
    expect(
      resolveTrackAlbumName(index, {
        relPath: "Artist/Album/song.mp3",
        album: "Old Title",
        albumId: "Artist::Album",
        albumFolderRelPath: "Artist/Album",
      }),
    ).toBe("New Title")
  })

  it("openTrackInLibrary opens renamed album", () => {
    const index = {
      artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 1 }],
      albums: [
        {
          id: "Artist::Album",
          artistId: "Artist",
          name: "New Title",
          relPath: "Artist/Album",
          trackCount: 1,
          loose: false,
          tracks: ["Artist/Album/song.mp3"],
        },
      ],
      tracks: [
        {
          relPath: "Artist/Album/song.mp3",
          artist: "Artist",
          album: "Old Title",
          albumId: "Artist::Album",
          albumFolderRelPath: "Artist/Album",
        },
      ],
    } as unknown as LibraryIndex
    const calls: string[] = []
    openTrackInLibrary(
      index,
      {
        relPath: "Artist/Album/song.mp3",
        title: "Song",
        artist: "Artist",
        album: "Old Title",
        albumId: "Artist::Album",
        albumFolderRelPath: "Artist/Album",
      },
      (id) => calls.push(`artist:${id}`),
      (artist, album) => calls.push(`album:${artist}/${album}`),
    )
    expect(calls).toEqual(["album:Artist/New Title"])
  })

  it("isFavoriteRelPath matches legacy Tracce paths", () => {
    const favorites = new Set(["Artist/Tracks/a.mp3"])
    expect(isFavoriteRelPath(favorites, "Artist/Tracce/a.mp3")).toBe(true)
    expect(isFavoriteRelPath(favorites, "Artist/Other/x.mp3")).toBe(false)
  })

  it("migrateLooseTrackPathsInUserState rewrites favorites and recent", () => {
    const state: UserStateV1 = {
      version: 1,
      favorites: ["Artist/Tracce/a.mp3"],
      recent: [
        {
          relPath: "Artist/Tracce/a.mp3",
          title: "A",
          artist: "Artist",
          album: "Tracce",
        },
      ],
      trackPlayCounts: {},
      playlists: [],
      queue: { tracks: [], currentIndex: 0 },
      settings: {
        defaultTab: "dashboard",
        vizMode: "bars",
        theme: "dark",
        glassSurface: "auto",
        customTheme: null,
      },
      shuffleExcludedAlbumIds: [],
      shuffleExcludedTrackRelPaths: [],
    }
    const out = migrateLooseTrackPathsInUserState(state)
    expect(out.favorites).toEqual(["Artist/Tracks/a.mp3"])
    expect(out.recent[0]?.relPath).toBe("Artist/Tracks/a.mp3")
    expect(out.loosePathsMigrated).toBe(true)
  })
})
