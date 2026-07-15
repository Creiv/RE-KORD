// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeLibraryDb, getLibraryDb } from "./db/index.mjs";
import { persistLibraryIndexToDb, buildLibraryIndexFromDb } from "./db/queries/library.mjs";

describe("libraryIndexService cache", () => {
  let tmp = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-idx-svc-"));
    await fs.mkdir(path.join(tmp, "Artist", "Album"), { recursive: true });
    await fs.writeFile(path.join(tmp, "Artist", "Album", "01.flac"), "fake");
    savedEnv.REKORD_USER_CONFIG_DIR = process.env.REKORD_USER_CONFIG_DIR;
    savedEnv.MUSIC_ROOT = process.env.MUSIC_ROOT;
    process.env.REKORD_USER_CONFIG_DIR = path.join(tmp, "cfg");
    process.env.MUSIC_ROOT = tmp;
    await fs.mkdir(process.env.REKORD_USER_CONFIG_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    if (tmp) closeLibraryDb(tmp);
    if (savedEnv.REKORD_USER_CONFIG_DIR === undefined) {
      delete process.env.REKORD_USER_CONFIG_DIR;
    } else {
      process.env.REKORD_USER_CONFIG_DIR = savedEnv.REKORD_USER_CONFIG_DIR;
    }
    if (savedEnv.MUSIC_ROOT === undefined) delete process.env.MUSIC_ROOT;
    else process.env.MUSIC_ROOT = savedEnv.MUSIC_ROOT;
    vi.resetModules();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  async function loadService() {
    const mod = await import("./libraryIndexService.mjs");
    mod.resetLibraryIndexServiceStateForTests();
    return mod;
  }

  it("seconda chiamata stesso epoch riusa la cache in-memory", async () => {
    const { getLibraryIndex, clearLibraryIndexCache } = await loadService();
    const queries = await import("./db/queries/library.mjs");
    const buildSpy = vi.spyOn(queries, "buildLibraryIndexFromDb");

    const first = await getLibraryIndex(tmp);
    const second = await getLibraryIndex(tmp);

    expect(second).toBe(first);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    clearLibraryIndexCache(tmp);
    buildSpy.mockRestore();
  });

  it("invalidateLibraryIndex forza rebuild", async () => {
    const { getLibraryIndex, invalidateLibraryIndex } = await loadService();
    const queries = await import("./db/queries/library.mjs");
    const buildSpy = vi.spyOn(queries, "buildLibraryIndexFromDb");

    await getLibraryIndex(tmp);
    await invalidateLibraryIndex(tmp);
    await getLibraryIndex(tmp);

    expect(buildSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    buildSpy.mockRestore();
  });

  it("backfillMissingArtworkCache al massimo una volta per root", async () => {
    const queries = await import("./db/queries/library.mjs");
    const backfillSpy = vi
      .spyOn(queries, "backfillMissingArtworkCache")
      .mockResolvedValue(undefined);

    const { getLibraryIndex } = await loadService();
    await getLibraryIndex(tmp);
    await getLibraryIndex(tmp);
    await getLibraryIndex(tmp);

    expect(backfillSpy).toHaveBeenCalledTimes(1);
    backfillSpy.mockRestore();
  });
});

describe("searchLibraryIndex account filter", () => {
  it("filtra risultati FTS al sotto-insieme dell'indice filtrato", async () => {
    vi.resetModules();
    const { searchLibraryIndex } = await import("./libraryIndexService.mjs");
    const queries = await import("./db/queries/library.mjs");
    vi.spyOn(queries, "searchLibraryDb").mockReturnValue({
      artists: [
        { id: "A1", name: "Allowed" },
        { id: "A2", name: "Hidden" },
      ],
      albums: [
        { relPath: "A1/Al1", name: "Visible" },
        { relPath: "A2/Al2", name: "Secret" },
      ],
      tracks: [
        { relPath: "A1/Al1/01.flac", title: "Ok" },
        { relPath: "A2/Al2/01.flac", title: "Nope" },
      ],
    });

    const filteredIndex = {
      musicRoot: "/music",
      artists: [{ id: "A1", name: "Allowed" }],
      albums: [{ relPath: "A1/Al1", name: "Visible" }],
      tracks: [{ relPath: "A1/Al1/01.flac", title: "Ok" }],
    };

    const results = searchLibraryIndex(filteredIndex, "test");
    expect(results.artists).toHaveLength(1);
    expect(results.artists[0].id).toBe("A1");
    expect(results.albums).toHaveLength(1);
    expect(results.tracks).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("buildLibraryIndexFromDb expectedTracks batch", () => {
  let tmp = "";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-expected-"));
    await fs.mkdir(path.join(tmp, "A1", "Al1"), { recursive: true });
    await fs.mkdir(path.join(tmp, "A2", "Al2"), { recursive: true });
    await fs.writeFile(path.join(tmp, "A1", "Al1", "01.flac"), "a");
    await fs.writeFile(path.join(tmp, "A2", "Al2", "01.flac"), "b");
  });

  afterEach(() => {
    closeLibraryDb(tmp);
  });

  it("carica expectedTracks per più album con una query batch", async () => {
    const index = {
      musicRoot: tmp,
      artists: [
        {
          id: "A1",
          name: "A1",
          albumCount: 1,
          trackCount: 1,
          releaseDate: null,
          coverRelPath: null,
          albums: ["A1::Al1"],
          albumsWithoutFileMetaCount: 0,
          tracksWithoutFileMetaCount: 0,
        },
        {
          id: "A2",
          name: "A2",
          albumCount: 1,
          trackCount: 1,
          releaseDate: null,
          coverRelPath: null,
          albums: ["A2::Al2"],
          albumsWithoutFileMetaCount: 0,
          tracksWithoutFileMetaCount: 0,
        },
      ],
      albums: [
        {
          id: "A1::Al1",
          artistId: "A1",
          artist: "A1",
          name: "Al1",
          relPath: "A1/Al1",
          trackCount: 1,
          coverRelPath: null,
          releaseDate: null,
          genre: null,
          label: null,
          country: null,
          musicbrainzReleaseId: null,
          discogsReleaseId: null,
          discogsUri: null,
          discogsExtra: null,
          expectedTrackCount: 2,
          expectedTracks: [
            { disc: 1, position: 1, title: "One" },
            { disc: 1, position: 2, title: "Two" },
          ],
          hasCover: false,
          hasAlbumMeta: false,
          hasTrackMeta: false,
          tracksWithoutFileMetaCount: 0,
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          tracks: ["A1/Al1/01.flac"],
        },
        {
          id: "A2::Al2",
          artistId: "A2",
          artist: "A2",
          name: "Al2",
          relPath: "A2/Al2",
          trackCount: 1,
          coverRelPath: null,
          releaseDate: null,
          genre: null,
          label: null,
          country: null,
          musicbrainzReleaseId: null,
          discogsReleaseId: null,
          discogsUri: null,
          discogsExtra: null,
          expectedTrackCount: 1,
          expectedTracks: [{ disc: 1, position: 1, title: "Alpha" }],
          hasCover: false,
          hasAlbumMeta: false,
          hasTrackMeta: false,
          tracksWithoutFileMetaCount: 0,
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
          tracks: ["A2/Al2/01.flac"],
        },
      ],
      tracks: [
        {
          id: "A1/Al1/01.flac",
          title: "One",
          relPath: "A1/Al1/01.flac",
          artist: "A1",
          album: "Al1",
          albumId: "A1::Al1",
          meta: {
            fileName: "01.flac",
            size: 1,
            mtime: Date.now(),
            releaseDate: null,
            genre: null,
            lyrics: null,
            moods: [],
            durationMs: null,
            trackNumber: 1,
            discNumber: null,
            source: null,
            url: null,
          },
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "A2/Al2/01.flac",
          title: "Alpha",
          relPath: "A2/Al2/01.flac",
          artist: "A2",
          album: "Al2",
          albumId: "A2::Al2",
          meta: {
            fileName: "01.flac",
            size: 1,
            mtime: Date.now(),
            releaseDate: null,
            genre: null,
            lyrics: null,
            moods: [],
            durationMs: null,
            trackNumber: 1,
            discNumber: null,
            source: null,
            url: null,
          },
          loose: false,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      stats: {
        artistCount: 2,
        albumCount: 2,
        trackCount: 2,
        favoriteCapableCount: 2,
        albumsWithoutCover: 2,
        albumsWithoutMeta: 2,
        tracksWithoutMeta: 0,
        looseAlbumCount: 0,
      },
    };

    await persistLibraryIndexToDb(tmp, index);
    const db = getLibraryDb(tmp);
    const prepareSpy = vi.spyOn(db, "prepare");

    const fromDb = buildLibraryIndexFromDb(tmp);
    const expectedPrepareCalls = prepareSpy.mock.calls.filter((call) =>
      String(call[0]).includes("album_expected_tracks WHERE album_id"),
    );
    expect(expectedPrepareCalls).toHaveLength(0);
    expect(fromDb.albums.find((a) => a.id === "A1::Al1")?.expectedTracks).toEqual([
      { disc: 1, position: 1, title: "One" },
      { disc: 1, position: 2, title: "Two" },
    ]);
    expect(fromDb.albums.find((a) => a.id === "A2::Al2")?.expectedTracks).toEqual([
      { disc: 1, position: 1, title: "Alpha" },
    ]);
    prepareSpy.mockRestore();
  });
});
