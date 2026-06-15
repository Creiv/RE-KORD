import { describe, expect, it, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { getLibraryDb, closeLibraryDb, isLibraryDbBootstrapped } from "./index.mjs"
import { persistLibraryIndexToDb, buildLibraryIndexFromDb } from "./queries/library.mjs"
import { saveAlbumMetaToDb, mergeLegacyAlbumJsonIntoDb, mergeLegacyTrackMapIntoDb } from "./queries/metadata.mjs"

describe("library db", () => {
  let tmp = ""

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-db-test-"))
    await fs.mkdir(path.join(tmp, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(tmp, "Artist", "Album", "01.flac"), "fake")
  })

  afterEach(() => {
    closeLibraryDb(tmp)
  })

  it("bootstraps and reads index from sqlite", async () => {
    const index = {
      musicRoot: tmp,
      artists: [
        {
          id: "Artist",
          name: "Artist",
          albumCount: 1,
          trackCount: 1,
          releaseDate: null,
          coverRelPath: null,
          albums: ["Artist::Album"],
          albumsWithoutFileMetaCount: 1,
          tracksWithoutFileMetaCount: 1,
        },
      ],
      albums: [
        {
          id: "Artist::Album",
          artistId: "Artist",
          artist: "Artist",
          name: "Album",
          relPath: "Artist/Album",
          trackCount: 1,
          coverRelPath: null,
          releaseDate: null,
          genre: null,
          label: null,
          country: null,
          musicbrainzReleaseId: null,
          expectedTrackCount: null,
          expectedTracks: null,
          hasCover: false,
          hasAlbumMeta: false,
          hasTrackMeta: false,
          tracksWithoutFileMetaCount: 1,
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          tracks: ["Artist/Album/01.flac"],
        },
      ],
      tracks: [
        {
          id: "Artist/Album/01.flac",
          title: "One",
          relPath: "Artist/Album/01.flac",
          artist: "Artist",
          album: "Album",
          albumId: "Artist::Album",
          meta: { fileName: "01.flac", size: 4, mtime: Date.now(), releaseDate: null, genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: 1, discNumber: null, source: null, url: null },
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      stats: {
        artistCount: 1,
        albumCount: 1,
        trackCount: 1,
        favoriteCapableCount: 1,
        albumsWithoutCover: 1,
        albumsWithoutMeta: 1,
        tracksWithoutMeta: 1,
        looseAlbumCount: 0,
      },
    }

    await persistLibraryIndexToDb(tmp, index)
    expect(isLibraryDbBootstrapped(tmp)).toBe(true)

    const fromDb = buildLibraryIndexFromDb(tmp)
    expect(fromDb.tracks).toHaveLength(1)
    expect(fromDb.albums[0]?.relPath).toBe("Artist/Album")
  })

  it("persists album metadata edits in sqlite", async () => {
    await persistLibraryIndexToDb(tmp, {
      musicRoot: tmp,
      artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 1, releaseDate: null, coverRelPath: null, albums: ["Artist::Album"], albumsWithoutFileMetaCount: 0, tracksWithoutFileMetaCount: 0 }],
      albums: [{
        id: "Artist::Album", artistId: "Artist", artist: "Artist", name: "Album", relPath: "Artist/Album", trackCount: 0, coverRelPath: null, releaseDate: null, genre: null, label: null, country: null, musicbrainzReleaseId: null, expectedTrackCount: null, expectedTracks: null, hasCover: false, hasAlbumMeta: false, hasTrackMeta: false, tracksWithoutFileMetaCount: 0, loose: false, addedAt: null, updatedAt: null, tracks: [],
      }],
      tracks: [],
      stats: { artistCount: 1, albumCount: 1, trackCount: 0, favoriteCapableCount: 0, albumsWithoutCover: 1, albumsWithoutMeta: 1, tracksWithoutMeta: 0, looseAlbumCount: 0 },
    })

    saveAlbumMetaToDb(tmp, "Artist/Album", { title: "Renamed", genre: "Rock" })
    const row = getLibraryDb(tmp).prepare("SELECT title, genre FROM albums WHERE folder_rel_path = ?").get("Artist/Album")
    expect(row?.title).toBe("Renamed")
    expect(row?.genre).toBe("Rock")
  })

  it("removes stale albums and artists on full rescan", async () => {
    const base = {
      musicRoot: tmp,
      artists: [
        {
          id: "Artist",
          name: "Artist",
          albumCount: 1,
          trackCount: 1,
          releaseDate: null,
          coverRelPath: null,
          albums: ["Artist::Album"],
          albumsWithoutFileMetaCount: 1,
          tracksWithoutFileMetaCount: 1,
        },
        {
          id: "Gone",
          name: "Gone",
          albumCount: 1,
          trackCount: 0,
          releaseDate: null,
          coverRelPath: null,
          albums: ["Gone::Old"],
          albumsWithoutFileMetaCount: 1,
          tracksWithoutFileMetaCount: 0,
        },
      ],
      albums: [
        {
          id: "Artist::Album",
          artistId: "Artist",
          artist: "Artist",
          name: "Album",
          relPath: "Artist/Album",
          trackCount: 1,
          coverRelPath: null,
          releaseDate: null,
          genre: null,
          label: null,
          country: null,
          musicbrainzReleaseId: null,
          expectedTrackCount: null,
          expectedTracks: null,
          hasCover: false,
          hasAlbumMeta: false,
          hasTrackMeta: false,
          tracksWithoutFileMetaCount: 1,
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          tracks: ["Artist/Album/01.flac"],
        },
        {
          id: "Gone::Old",
          artistId: "Gone",
          artist: "Gone",
          name: "Old",
          relPath: "Gone/Old",
          trackCount: 0,
          coverRelPath: null,
          releaseDate: null,
          genre: null,
          label: null,
          country: null,
          musicbrainzReleaseId: null,
          expectedTrackCount: null,
          expectedTracks: null,
          hasCover: false,
          hasAlbumMeta: false,
          hasTrackMeta: false,
          tracksWithoutFileMetaCount: 0,
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          tracks: [],
        },
      ],
      tracks: [
        {
          id: "Artist/Album/01.flac",
          title: "One",
          relPath: "Artist/Album/01.flac",
          artist: "Artist",
          album: "Album",
          albumId: "Artist::Album",
          meta: { fileName: "01.flac", size: 4, mtime: Date.now(), releaseDate: null, genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: 1, discNumber: null, source: null, url: null },
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      stats: {
        artistCount: 2,
        albumCount: 2,
        trackCount: 1,
        favoriteCapableCount: 1,
        albumsWithoutCover: 2,
        albumsWithoutMeta: 2,
        tracksWithoutMeta: 1,
        looseAlbumCount: 0,
      },
    }

    await persistLibraryIndexToDb(tmp, base)
    await persistLibraryIndexToDb(tmp, {
      ...base,
      artists: [base.artists[0]],
      albums: [base.albums[0]],
    })

    const db = getLibraryDb(tmp)
    expect(db.prepare("SELECT id FROM artists ORDER BY id").all().map((r) => r.id)).toEqual(["Artist"])
    expect(db.prepare("SELECT id FROM albums ORDER BY id").all().map((r) => r.id)).toEqual(["Artist::Album"])
  })

  it("orders album tracks by file name when reading from sqlite", async () => {
    const index = {
      musicRoot: tmp,
      artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 3, releaseDate: null, coverRelPath: null, albums: ["Artist::Album"], albumsWithoutFileMetaCount: 0, tracksWithoutFileMetaCount: 0 }],
      albums: [{
        id: "Artist::Album", artistId: "Artist", artist: "Artist", name: "Album", relPath: "Artist/Album", trackCount: 3, coverRelPath: null, releaseDate: "2020", genre: null, label: null, country: null, musicbrainzReleaseId: null, expectedTrackCount: null, expectedTracks: null, hasCover: false, hasAlbumMeta: false, hasTrackMeta: false, tracksWithoutFileMetaCount: 0, loose: false, addedAt: null, updatedAt: null,
        tracks: ["Artist/Album/03.flac", "Artist/Album/01.flac", "Artist/Album/02.flac"],
      }],
      tracks: [
        { id: "Artist/Album/03.flac", title: "Three", relPath: "Artist/Album/03.flac", artist: "Artist", album: "Album", albumId: "Artist::Album", meta: { fileName: "03.flac", size: 4, mtime: Date.now(), releaseDate: "2020", genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: 3, discNumber: null, source: null, url: null }, loose: false, addedAt: Date.now(), updatedAt: Date.now() },
        { id: "Artist/Album/01.flac", title: "One", relPath: "Artist/Album/01.flac", artist: "Artist", album: "Album", albumId: "Artist::Album", meta: { fileName: "01.flac", size: 4, mtime: Date.now(), releaseDate: "2020", genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: 1, discNumber: null, source: null, url: null }, loose: false, addedAt: Date.now(), updatedAt: Date.now() },
        { id: "Artist/Album/02.flac", title: "Two", relPath: "Artist/Album/02.flac", artist: "Artist", album: "Album", albumId: "Artist::Album", meta: { fileName: "02.flac", size: 4, mtime: Date.now(), releaseDate: "2020", genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: 2, discNumber: null, source: null, url: null }, loose: false, addedAt: Date.now(), updatedAt: Date.now() },
      ],
      stats: { artistCount: 1, albumCount: 1, trackCount: 3, favoriteCapableCount: 3, albumsWithoutCover: 1, albumsWithoutMeta: 1, tracksWithoutMeta: 0, looseAlbumCount: 0 },
    }

    await persistLibraryIndexToDb(tmp, index)
    const fromDb = buildLibraryIndexFromDb(tmp)
    expect(fromDb.albums[0]?.tracks).toEqual([
      "Artist/Album/01.flac",
      "Artist/Album/02.flac",
      "Artist/Album/03.flac",
    ])
  })

  it("merges legacy JSON into DB only for empty fields", async () => {
    await persistLibraryIndexToDb(tmp, {
      musicRoot: tmp,
      artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 1, releaseDate: null, coverRelPath: null, albums: ["Artist::Album"], albumsWithoutFileMetaCount: 0, tracksWithoutFileMetaCount: 0 }],
      albums: [{
        id: "Artist::Album", artistId: "Artist", artist: "Artist", name: "Album", relPath: "Artist/Album", trackCount: 1, coverRelPath: null, releaseDate: null, genre: null, label: null, country: null, musicbrainzReleaseId: null, expectedTrackCount: null, expectedTracks: null, hasCover: false, hasAlbumMeta: false, hasTrackMeta: false, tracksWithoutFileMetaCount: 0, loose: false, addedAt: null, updatedAt: null, tracks: ["Artist/Album/01.flac"],
      }],
      tracks: [{
        id: "Artist/Album/01.flac", title: "01.flac", relPath: "Artist/Album/01.flac", artist: "Artist", album: "Album", albumId: "Artist::Album",
        meta: { fileName: "01.flac", size: 4, mtime: Date.now(), releaseDate: null, genre: null, lyrics: null, moods: [], durationMs: null, trackNumber: null, discNumber: null, source: null, url: null },
        loose: false, addedAt: Date.now(), updatedAt: Date.now(),
      }],
      stats: { artistCount: 1, albumCount: 1, trackCount: 1, favoriteCapableCount: 1, albumsWithoutCover: 1, albumsWithoutMeta: 1, tracksWithoutMeta: 1, looseAlbumCount: 0 },
    })

    const albumMerge = mergeLegacyAlbumJsonIntoDb(tmp, "Artist/Album", {
      title: "Legacy Title",
      genre: "Rock",
      expectedTracks: [{ disc: 1, position: 1, title: "X" }],
      expectedTrackCount: 1,
    })
    expect(albumMerge.merged).toBe(true)
    expect(albumMerge.fieldCount).toBeGreaterThan(0)

    const albumRow = getLibraryDb(tmp).prepare("SELECT title, genre FROM albums WHERE folder_rel_path = ?").get("Artist/Album")
    expect(albumRow?.title).toBe("Legacy Title")
    expect(albumRow?.genre).toBe("Rock")
    expect(
      getLibraryDb(tmp).prepare("SELECT COUNT(*) AS n FROM album_expected_tracks").get()?.n,
    ).toBe(0)

    const trackMerge = mergeLegacyTrackMapIntoDb(tmp, "Artist/Album", {
      "01.flac": { genre: "Pop", trackNumber: 3 },
    })
    expect(trackMerge.merged).toBe(1)
    const trackRow = getLibraryDb(tmp).prepare("SELECT title, genre, track_number FROM tracks WHERE rel_path = ?").get("Artist/Album/01.flac")
    expect(trackRow?.title).toBe("01.flac")
    expect(trackRow?.genre).toBe("Pop")
    expect(trackRow?.track_number).toBeNull()
  })

  it("still persists expectedTracks on manual album metadata save", async () => {
    await persistLibraryIndexToDb(tmp, {
      musicRoot: tmp,
      artists: [{ id: "Artist", name: "Artist", albumCount: 1, trackCount: 0, releaseDate: null, coverRelPath: null, albums: ["Artist::Album"], albumsWithoutFileMetaCount: 0, tracksWithoutFileMetaCount: 0 }],
      albums: [{
        id: "Artist::Album", artistId: "Artist", artist: "Artist", name: "Album", relPath: "Artist/Album", trackCount: 0, coverRelPath: null, releaseDate: null, genre: null, label: null, country: null, musicbrainzReleaseId: null, expectedTrackCount: null, expectedTracks: null, hasCover: false, hasAlbumMeta: false, hasTrackMeta: false, tracksWithoutFileMetaCount: 0, loose: false, addedAt: null, updatedAt: null, tracks: [],
      }],
      tracks: [],
      stats: { artistCount: 1, albumCount: 1, trackCount: 0, favoriteCapableCount: 0, albumsWithoutCover: 1, albumsWithoutMeta: 1, tracksWithoutMeta: 0, looseAlbumCount: 0 },
    })

    const expectedTracks = [
      { disc: 1, position: 1, title: "Intro" },
      { disc: 1, position: 2, title: "Main" },
    ]
    const saved = saveAlbumMetaToDb(tmp, "Artist/Album", {
      title: "Fetched",
      expectedTracks,
      expectedTrackCount: 2,
    })
    expect(saved.expectedTracks).toHaveLength(2)
    expect(saved.expectedTracks?.[0]?.title).toBe("Intro")

    const rows = getLibraryDb(tmp)
      .prepare("SELECT title FROM album_expected_tracks WHERE album_id = ? ORDER BY position")
      .all("Artist::Album")
    expect(rows.map((r) => r.title)).toEqual(["Intro", "Main"])
  })
})
