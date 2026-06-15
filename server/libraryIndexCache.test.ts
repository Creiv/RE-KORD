// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import { readLibraryIndexCache } from "./libraryIndexCache.mjs"

const SCHEMA_VERSION = 1

function minimalIndex(musicRoot: string, tracks: object[] = []) {
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
  }
}

async function writeLegacyCacheFile(musicRoot: string, index: object) {
  const dir = path.join(musicRoot, ".kord")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "library-index.v1.cache.json"),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, builtAt: new Date().toISOString(), index }),
    "utf8",
  )
}

describe("libraryIndexCache", () => {
  it("legge la cache legacy sotto .kord/ per bootstrap", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-idx-cache-"))
    const idx = minimalIndex(musicRoot)
    await writeLegacyCacheFile(musicRoot, idx)
    const read = await readLibraryIndexCache(musicRoot)
    expect(read?.stats?.trackCount).toBe(0)
    expect(path.resolve(read?.musicRoot || "")).toBe(path.resolve(musicRoot))
  })

  it("restituisce null se la cache non esiste o è invalida", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-idx-miss-"))
    expect(await readLibraryIndexCache(musicRoot)).toBeNull()
    await writeLegacyCacheFile(musicRoot, { ...minimalIndex(musicRoot), musicRoot: "/other" })
    expect(await readLibraryIndexCache(musicRoot)).toBeNull()
  })
})
