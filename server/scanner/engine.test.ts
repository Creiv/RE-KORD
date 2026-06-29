// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  diffAgainstFilesTable,
  resolveAlbumFolderRelPath,
  resolveScopeFromPath,
  resolveScopesFromPaths,
  walkFilesystemStats,
} from "./engine.mjs"
import { closeLibraryDb, getLibraryDb } from "../db/index.mjs"

describe("scanner engine", () => {
  let tmp = ""

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-engine-"))
    await fs.mkdir(path.join(tmp, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(tmp, "Artist", "Album", "01 Song.mp3"), "audio-a")
    await fs.writeFile(path.join(tmp, "Artist", "Loose.mp3"), "audio-b")
  })

  afterEach(() => {
    closeLibraryDb(tmp)
  })

  it("walkFilesystemStats collects audio paths", async () => {
    const map = await walkFilesystemStats(tmp)
    expect(map.has("Artist/Album/01 Song.mp3")).toBe(true)
    expect(map.has("Artist/Loose.mp3")).toBe(true)
    expect(map.size).toBe(2)
  })

  it("diffAgainstFilesTable detects added files", () => {
    const db = getLibraryDb(tmp)
    db.prepare(
      "INSERT INTO files (rel_path, size, mtime_ns) VALUES (?, ?, ?)",
    ).run("Artist/Album/01 Song.mp3", 1, 1000)

    const fsEntries = new Map([
      [
        "Artist/Album/01 Song.mp3",
        { relPath: "Artist/Album/01 Song.mp3", size: 1, mtimeNs: 1000 },
      ],
      [
        "Artist/Loose.mp3",
        { relPath: "Artist/Loose.mp3", size: 6, mtimeNs: 2000 },
      ],
    ])

    const diff = diffAgainstFilesTable(db, fsEntries)
    expect(diff.added).toEqual(["Artist/Loose.mp3"])
    expect(diff.unchanged).toEqual(["Artist/Album/01 Song.mp3"])
  })

  it("resolveScopeFromPath maps album and artist paths", () => {
    const album = resolveScopeFromPath(
      tmp,
      path.join(tmp, "Artist", "Album", "01 Song.mp3"),
    )
    expect(album.scopes).toEqual(["Artist/Album"])

    const artist = resolveScopeFromPath(tmp, path.join(tmp, "Artist", "Loose.mp3"))
    expect(artist.scopes).toEqual(["Artist"])
  })

  it("resolveScopesFromPaths deduplicates scopes", () => {
    const scopes = resolveScopesFromPaths(tmp, [
      path.join(tmp, "Artist", "Album", "01 Song.mp3"),
      path.join(tmp, "Artist", "Album", "02 Song.mp3"),
    ])
    expect(scopes).toEqual(["Artist/Album"])
  })

  it("resolveAlbumFolderRelPath maps loose Tracks to artist folder", () => {
    const db = getLibraryDb(tmp)
    db.prepare(`INSERT INTO artists (id, name) VALUES ('a1', 'Artist')`).run()
    db.prepare(
      `INSERT INTO albums (id, artist_id, name, folder_rel_path, loose)
       VALUES ('al-loose', 'a1', 'Tracks', 'Artist', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO albums (id, artist_id, name, folder_rel_path, loose)
       VALUES ('al-album', 'a1', 'Album', 'Artist/Album', 0)`,
    ).run()
    db.prepare(
      `INSERT INTO tracks (id, album_id, title, rel_path, file_path, artist_name, album_name, loose)
       VALUES ('t-loose', 'al-loose', 'Loose', 'Artist/Tracks/Loose.mp3', 'Artist/Loose.mp3', 'Artist', 'Tracks', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO tracks (id, album_id, title, rel_path, file_path, artist_name, album_name)
       VALUES ('t-album', 'al-album', 'Song', 'Artist/Album/01 Song.mp3', 'Artist/Album/01 Song.mp3', 'Artist', 'Album')`,
    ).run()

    expect(resolveAlbumFolderRelPath(tmp, "Artist/Tracks/Loose.mp3")).toBe(
      "Artist",
    )
    expect(resolveAlbumFolderRelPath(tmp, "Artist/Album/01 Song.mp3")).toBe(
      "Artist/Album",
    )
  })
})
