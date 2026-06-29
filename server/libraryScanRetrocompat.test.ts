// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "vitest"
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
  it("migrates file_path and incremental scan adds tracks", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-retro-"))
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

    closeLibraryDb(musicRoot)
  })
})
