// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { closeLibraryDb, getLibraryDb } from "./index.mjs"
import { saveTrackMetaToDb } from "./queries/metadata.mjs"

describe("loose track metadata save", () => {
  /** @type {string} */
  let tmp

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-loose-meta-"))
    const db = getLibraryDb(tmp)
    db.prepare(`INSERT INTO artists (id, name) VALUES ('Artist', 'Artist')`).run()
    db.prepare(
      `INSERT INTO albums (id, artist_id, name, folder_rel_path, loose, track_count)
       VALUES ('Artist::Tracks', 'Artist', 'Tracks', 'Artist', 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO tracks (
        id, rel_path, file_path, album_id, title, artist_name, album_name,
        file_name, loose
      ) VALUES (
        'Artist/Tracks/Loose.mp3',
        'Artist/Tracks/Loose.mp3',
        'Artist/Loose.mp3',
        'Artist::Tracks',
        'Loose',
        'Artist',
        'Tracks',
        'Loose.mp3',
        1
      )`,
    ).run()
    db.prepare(
      `UPDATE library_state SET bootstrapped_at = datetime('now') WHERE id = 1`,
    ).run()
  })

  afterEach(() => {
    closeLibraryDb(tmp)
  })

  it("saveTrackMetaToDb resolves loose track via file_path", () => {
    const saved = saveTrackMetaToDb(tmp, "Artist/Loose.mp3", {
      title: "Edited loose",
      genre: "Hip-Hop",
    })
    expect(saved.title).toBe("Edited loose")
    expect(saved.genre).toBe("Hip-Hop")

    const row = getLibraryDb(tmp)
      .prepare("SELECT title, genre, user_edited FROM tracks WHERE rel_path = ?")
      .get("Artist/Tracks/Loose.mp3")
    expect(row?.title).toBe("Edited loose")
    expect(row?.genre).toBe("Hip-Hop")
    expect(row?.user_edited).toBe(1)
  })

  it("saveTrackMetaToDb resolves loose track via logical rel_path", () => {
    const saved = saveTrackMetaToDb(tmp, "Artist/Tracks/Loose.mp3", {
      title: "Edited via rel path",
    })
    expect(saved.title).toBe("Edited via rel path")
  })
})
