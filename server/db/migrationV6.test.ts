// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import Database from "better-sqlite3"
import { describe, expect, it, afterEach } from "vitest"
import { MIGRATION_SQL, SCHEMA_VERSION } from "./schema.mjs"
import { migrateV6LoosePaths, resolveLooseTrackPaths } from "./migrateV6.mjs"
import { closeLibraryDb, getLibraryDb } from "./index.mjs"
import { resolveTrackFileRelPath } from "../scanner/engine.mjs"

function seedLegacyV5Db(dbPath: string) {
  const db = new Database(dbPath)
  db.exec(MIGRATION_SQL)
  try {
    db.exec("ALTER TABLE tracks ADD COLUMN file_path TEXT")
  } catch {
    /* ok */
  }
  db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(5)
  db.prepare(
    "UPDATE library_state SET bootstrapped_at = ?, epoch = 1 WHERE id = 1",
  ).run(new Date().toISOString())

  db.prepare(
    `INSERT INTO artists (id, name, album_count, track_count) VALUES ('Artist', 'Artist', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO albums (id, artist_id, folder_rel_path, name, loose, track_count)
     VALUES ('Artist::Tracce', 'Artist', 'Artist', 'Tracce', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO tracks (
      id, rel_path, file_path, album_id, title, artist_name, album_name, loose
    ) VALUES (
      'Artist/Tracce/song.mp3',
      'Artist/Tracce/song.mp3',
      'Artist/Tracce/song.mp3',
      'Artist::Tracce',
      'Song',
      'Artist',
      'Tracce',
      1
    )`,
  ).run()
  db.prepare(
    `INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path)
     VALUES ('Song', 'Artist', 'Tracce', '', 'Artist/Tracce/song.mp3')`,
  ).run()
  db.prepare(
    `INSERT INTO files (rel_path, size, mtime_ns) VALUES ('Artist/Tracce/song.mp3', 100, 0)`,
  ).run()
  db.close()
}

describe("migration v6", () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots) {
      closeLibraryDb(root)
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
    roots.length = 0
  })

  it("resolveLooseTrackPaths maps Tracce segment to disk path", () => {
    expect(resolveLooseTrackPaths("Artist/Tracce/song.mp3")).toEqual({
      newRelPath: "Artist/Tracks/song.mp3",
      newFilePath: "Artist/song.mp3",
      newAlbumId: "Artist::Tracks",
    })
  })

  it("migrates legacy loose album and track paths", async () => {
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-mig6-"))
    roots.push(musicRoot)
    const rekordDir = path.join(musicRoot, ".kord")
    await fs.mkdir(rekordDir, { recursive: true })
    await fs.mkdir(path.join(musicRoot, "Artist"), { recursive: true })
    await fs.writeFile(path.join(musicRoot, "Artist", "song.mp3"), "x")

    seedLegacyV5Db(path.join(rekordDir, "rekord.db"))

    const db = getLibraryDb(musicRoot)
    const ver = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number
    }
    expect(ver.v).toBe(SCHEMA_VERSION)

    const album = db
      .prepare("SELECT id, folder_rel_path FROM albums WHERE loose = 1")
      .get() as { id: string; folder_rel_path: string }
    expect(album.id).toBe("Artist::Tracks")
    expect(album.folder_rel_path).toBe("Artist")

    const track = db
      .prepare("SELECT rel_path, file_path, album_id FROM tracks WHERE loose = 1")
      .get() as { rel_path: string; file_path: string; album_id: string }
    expect(track.rel_path).toBe("Artist/Tracks/song.mp3")
    expect(track.file_path).toBe("Artist/song.mp3")
    expect(track.album_id).toBe("Artist::Tracks")

    expect(resolveTrackFileRelPath(musicRoot, "Artist/Tracks/song.mp3")).toBe(
      "Artist/song.mp3",
    )

    const fileRow = db.prepare("SELECT rel_path FROM files WHERE rel_path = ?").get(
      "Artist/song.mp3",
    )
    expect(fileRow).toBeTruthy()
  })

  it("migrateV6LoosePaths is idempotent", () => {
    const db = new Database(":memory:")
    db.exec(MIGRATION_SQL)
    try {
      db.exec("ALTER TABLE tracks ADD COLUMN file_path TEXT")
    } catch {
      /* colonna già in schema */
    }
    db.prepare("INSERT INTO artists (id, name) VALUES ('A', 'A')").run()
    db.prepare(
      `INSERT INTO albums (id, artist_id, folder_rel_path, name, loose)
       VALUES ('A::Tracks', 'A', 'A', 'Tracks', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO tracks (id, rel_path, file_path, album_id, title, artist_name, album_name, loose)
       VALUES ('A/Tracks/x.mp3', 'A/Tracks/x.mp3', 'A/x.mp3', 'A::Tracks', 'X', 'A', 'Tracks', 1)`,
    ).run()
    migrateV6LoosePaths(db)
    migrateV6LoosePaths(db)
    const row = db.prepare("SELECT rel_path, file_path FROM tracks").get() as {
      rel_path: string
      file_path: string
    }
    expect(row.rel_path).toBe("A/Tracks/x.mp3")
    expect(row.file_path).toBe("A/x.mp3")
    db.close()
  })
})
