// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it, afterEach } from "vitest"
import { buildLibraryIndex } from "./musicLibrary.mjs"
import { closeLibraryDb } from "./db/index.mjs"
import {
  persistIncrementalToDb,
  persistLibraryIndexToDb,
  buildLibraryIndexFromDb,
} from "./db/queries/library.mjs"
import { runScanEngine } from "./scanner/engine.mjs"
import { getLibraryEpoch, getLibraryDb } from "./db/index.mjs"

describe("library scan retrocompat", () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots) {
      closeLibraryDb(root)
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
    roots.length = 0
  })

  it("migrates file_path and incremental scan adds tracks", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-retro-"))
    roots.push(musicRoot)
    await fs.mkdir(path.join(musicRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(musicRoot, "Artist", "Album", "01.flac"), "x")

    const full = await buildLibraryIndex(musicRoot, { enrichDuration: false })
    await persistLibraryIndexToDb(musicRoot, full)
    const epoch1 = getLibraryEpoch(musicRoot)

    const db = getLibraryDb(musicRoot)
    const row = db
      .prepare("SELECT file_path, rel_path FROM tracks WHERE rel_path = ?")
      .get("Artist/Album/01.flac")
    expect(row?.file_path).toBe("Artist/Album/01.flac")

    await fs.writeFile(path.join(musicRoot, "Artist", "Album", "02.flac"), "y")
    const result = await runScanEngine(musicRoot, {
      paths: [path.join(musicRoot, "Artist", "Album")],
      enrichDuration: false,
    })
    expect(result.mode).toBe("incremental")
    await persistIncrementalToDb(musicRoot, result.index!, {
      removedPaths: result.removedPaths,
    })

    const fromDb = buildLibraryIndexFromDb(musicRoot)
    expect(fromDb.tracks).toHaveLength(2)
    expect(getLibraryEpoch(musicRoot)).toBe(epoch1 + 1)
  })

  it("incremental upsert preserves expectedTracks when not in payload", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-exp-"))
    roots.push(musicRoot)
    await fs.mkdir(path.join(musicRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(musicRoot, "Artist", "Album", "01.flac"), "x")

    const full = await buildLibraryIndex(musicRoot, { enrichDuration: false })
    full.albums[0].expectedTracks = [{ disc: 1, position: 1, title: "Expected" }]
    await persistLibraryIndexToDb(musicRoot, full)

    const partial = await buildLibraryIndex(musicRoot, { enrichDuration: false })
    delete partial.albums[0].expectedTracks
    await persistIncrementalToDb(musicRoot, partial, { removedPaths: [] })

    const db = getLibraryDb(musicRoot)
    const expected = db
      .prepare("SELECT title FROM album_expected_tracks WHERE album_id = ?")
      .all("Artist::Album")
    expect(expected).toHaveLength(1)
    expect(expected[0]?.title).toBe("Expected")
  })

  it("prunes empty album after last track removed outside artist scope", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-prune-"))
    roots.push(musicRoot)
    await fs.mkdir(path.join(musicRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(musicRoot, "Artist", "Album", "01.flac"), "x")

    const full = await buildLibraryIndex(musicRoot, { enrichDuration: false })
    await persistLibraryIndexToDb(musicRoot, full)

    await persistIncrementalToDb(
      musicRoot,
      { musicRoot, artists: [], albums: [], tracks: [] },
      { removedPaths: ["Artist/Album/01.flac"] },
    )

    const db = getLibraryDb(musicRoot)
    const album = db.prepare("SELECT id FROM albums WHERE id = ?").get("Artist::Album")
    expect(album).toBeUndefined()
    const artist = db.prepare("SELECT id FROM artists WHERE id = ?").get("Artist")
    expect(artist).toBeUndefined()
  })
})
