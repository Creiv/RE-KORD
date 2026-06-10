// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  invalidateLibraryIndexCache,
  patchTrackInLibraryIndexCache,
  readLibraryIndexCache,
  writeLibraryIndexCache,
} from "./libraryIndexCache.mjs";

function minimalIndex(musicRoot, tracks = []) {
  return {
    musicRoot,
    artists: [],
    albums: [],
    tracks,
    stats: {
      artistCount: 0,
      albumCount: 0,
      trackCount: tracks.length,
      favoriteCapableCount: 0,
      albumsWithoutCover: 0,
      albumsWithoutMeta: 0,
      tracksWithoutMeta: 0,
      looseAlbumCount: 0,
    },
  };
}

describe("libraryIndexCache", () => {
  it("scrive e rilegge la cache sotto .kord/", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-idx-cache-"));
    const idx = minimalIndex(musicRoot);
    await writeLibraryIndexCache(musicRoot, idx);
    const read = await readLibraryIndexCache(musicRoot);
    expect(read?.stats?.trackCount).toBe(0);
    expect(path.resolve(read?.musicRoot || "")).toBe(path.resolve(musicRoot));
    await invalidateLibraryIndexCache(musicRoot);
    expect(await readLibraryIndexCache(musicRoot)).toBeNull();
  });

  it("patch paralleli non perdono aggiornamenti meta", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-idx-patch-"));
    const tracks = Array.from({ length: 12 }, (_, i) => ({
      relPath: `Artist/Album/track-${i}.mp3`,
      title: `Track ${i}`,
      artist: "Artist",
      album: "Album",
      albumId: "artist::Album",
      meta: { genre: null },
    }));
    await writeLibraryIndexCache(musicRoot, minimalIndex(musicRoot, tracks));

    await Promise.all(
      tracks.map((tr, i) =>
        patchTrackInLibraryIndexCache(musicRoot, tr.relPath, {
          meta: { genre: `Genre-${i}` },
        }),
      ),
    );

    const read = await readLibraryIndexCache(musicRoot);
    expect(read?.tracks).toHaveLength(12);
    for (let i = 0; i < 12; i += 1) {
      const row = read?.tracks.find((t) => t.relPath === tracks[i].relPath);
      expect(row?.meta?.genre).toBe(`Genre-${i}`);
    }
  });
});
