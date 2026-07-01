import { describe, expect, it } from "vitest"
import {
  artistHasOnlyLooseAlbum,
  enrichTracksFromLibrary,
  findLibraryTrackByRelPath,
  formatTrackByline,
  isFavoriteRelPath,
  isLooseTrack,
  legacyLooseRelPath,
  lookupByRelPathAliases,
  looseRelPathAliases,
  migrateLooseTrackPathsInUserState,
  openArtistInLibrary,
  openTrackInLibrary,
  relPathSetHas,
  resolveTrackAlbumName,
  resolveTrackFromLibrary,
} from "./libraryNav"
import type { EnrichedTrack, LibraryIndex, UserStateV1 } from "../types"

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
        id: "Artist/Tracks/a.mp3",
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
        id: "Artist/Tracce/a.mp3",
        relPath: "Artist/Tracce/a.mp3",
        title: "A",
        artist: "Artist",
        album: "Tracce",
      } as EnrichedTrack,
      looseIndex.tracks,
    )
    expect(full.filePath).toBe("Artist/a.mp3")
    expect(full.relPath).toBe("Artist/Tracks/a.mp3")
  })

  it("enrichTracksFromLibrary allinea recent stub con indice libreria", () => {
    const [enriched] = enrichTracksFromLibrary(
      [
        {
          id: "Artist/Tracks/a.mp3",
          relPath: "Artist/Tracks/a.mp3",
          title: "Stale",
          artist: "Artist",
          album: "Tracce",
        } as EnrichedTrack,
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
        id: "Artist/Album/song.mp3",
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

  it("looseRelPathAliases returns Tracce and Tracks variants", () => {
    expect(looseRelPathAliases("Artist/Tracce/a.mp3")).toEqual([
      "Artist/Tracce/a.mp3",
      "Artist/Tracks/a.mp3",
    ])
    expect(looseRelPathAliases("Artist/Album/song.mp3")).toEqual([
      "Artist/Album/song.mp3",
    ])
  })

  it("relPathSetHas and lookupByRelPathAliases resolve legacy keys", () => {
    const set = new Set(["Artist/Tracks/a.mp3"])
    expect(relPathSetHas(set, "Artist/Tracce/a.mp3")).toBe(true)
    const counts = { "Artist/Tracks/a.mp3": 5 }
    expect(lookupByRelPathAliases(counts, "Artist/Tracce/a.mp3")).toBe(5)
  })

  it("findLibraryTrackByRelPath matches legacy Tracce path", () => {
    const hit = findLibraryTrackByRelPath(
      looseIndex.tracks,
      "Artist/Tracce/a.mp3",
    )
    expect(hit?.relPath).toBe("Artist/Tracks/a.mp3")
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
          id: "Artist/Tracce/a.mp3",
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
        theme: "midnight",
        restoreSession: false,
        locale: "it",
        libBrowse: "artists",
        libOverviewSort: "name",
        artistAlbumSort: "date",
        audioCrossfadeSec: 0,
        plectrDisableVizBackdrop: false,
        glassSurfaces: false,
        glassOpacity: 62,
      },
      shuffleExcludedAlbumIds: [],
      shuffleExcludedTrackRelPaths: [],
    }
    const out = migrateLooseTrackPathsInUserState(state)
    expect(out.favorites).toEqual(["Artist/Tracks/a.mp3"])
    expect(out.recent[0]?.relPath).toBe("Artist/Tracks/a.mp3")
    expect(out.loosePathsMigrated).toBe(true)
  })

  it("migrateLooseTrackPathsInUserState rewrites trackPlayCounts and plectrBests", () => {
    const state: UserStateV1 = {
      version: 1,
      favorites: [],
      recent: [],
      trackPlayCounts: {
        "Artist/Tracce/a.mp3": 3,
        "Artist/Tracks/b.mp3": 2,
      },
      plectrBests: {
        "Artist/Tracce/a.mp3": {
          score: 100,
          grade: "A",
          accuracy: 0.9,
          maxCombo: 10,
          hits: 50,
          misses: 2,
          updatedAt: "2024-01-01",
        },
        "Artist/Tracks/a.mp3": {
          score: 120,
          grade: "S",
          accuracy: 0.95,
          maxCombo: 12,
          hits: 55,
          misses: 1,
          updatedAt: "2024-02-01",
        },
      },
      playlists: [],
      queue: { tracks: [], currentIndex: 0 },
      settings: {
        defaultTab: "dashboard",
        vizMode: "bars",
        theme: "midnight",
        restoreSession: false,
        locale: "it",
        libBrowse: "artists",
        libOverviewSort: "name",
        artistAlbumSort: "date",
        audioCrossfadeSec: 0,
        plectrDisableVizBackdrop: false,
        glassSurfaces: false,
        glassOpacity: 62,
      },
      shuffleExcludedAlbumIds: [],
      shuffleExcludedTrackRelPaths: [],
    }
    const out = migrateLooseTrackPathsInUserState(state)
    expect(out.trackPlayCounts).toEqual({
      "Artist/Tracks/a.mp3": 3,
      "Artist/Tracks/b.mp3": 2,
    })
    expect(out.plectrBests?.["Artist/Tracks/a.mp3"]?.score).toBe(120)
  })
})
