// @vitest-environment node
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import archiver from "archiver"
import { createWriteStream } from "fs"

const ENV_KEYS = ["REKORD_USER_CONFIG_DIR", "MUSIC_ROOT", "REKORD_YTDLP_COOKIES"] as const

async function writeZipFromPlan(plan, zipPath) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath)
    const archive = archiver("zip", { zlib: { level: 6 } })
    archive.on("error", reject)
    output.on("close", resolve)
    archive.pipe(output)
    void (async () => {
      for (const e of plan) {
        if (e._body != null) archive.append(e._body, { name: e.zipName })
        else archive.file(e.abs, { name: e.zipName })
      }
      await archive.finalize()
    })()
  })
}

describe("backupRekord", () => {
  let tmpRoot = ""
  let cfgDir = ""
  let libRoot = ""
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-backup-test-"))
    cfgDir = path.join(tmpRoot, "cfg")
    libRoot = path.join(tmpRoot, "lib")
    await fs.mkdir(cfgDir, { recursive: true })
    await fs.mkdir(libRoot, { recursive: true })
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.REKORD_USER_CONFIG_DIR = cfgDir
    vi.resetModules()
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    vi.resetModules()
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function bootstrapLibrary() {
    const { CONFIG_FILE, reloadConfigFromDisk, waitForInitialLayoutMigration } =
      await import("./musicRootConfig.mjs")
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify(
        {
          musicRoot: libRoot,
          schemaVersion: 3,
          accounts: [{ id: "default", name: "Default" }],
        },
        null,
        2,
      ),
      "utf8",
    )
    reloadConfigFromDisk()
    await waitForInitialLayoutMigration()
    return { CONFIG_FILE }
  }

  it("includes custom theme background, youtube cookies, and album covers", async () => {
    const { CONFIG_FILE } = await bootstrapLibrary()
    const { buildKordBackupPlan } = await import("./backupRekord.mjs")
    const { getAccountsSnapshot } = await import("./musicRootConfig.mjs")
    const { rekordAccountDir } = await import("./rekordDataStore.mjs")

    const accDir = rekordAccountDir(libRoot, "default")
    expect(accDir).toBeTruthy()
    await fs.mkdir(accDir!, { recursive: true })
    const themeBg = path.join(accDir!, "theme-bg.webp")
    const themeBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00])
    await fs.writeFile(themeBg, themeBytes)
    await fs.writeFile(
      path.join(accDir!, "user-state.json"),
      JSON.stringify({ version: 1, settings: { theme: "custom" } }, null, 2),
      "utf8",
    )

    await fs.writeFile(
      path.join(cfgDir, "youtube-cookies.txt"),
      "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tfoo\tbar\n",
      "utf8",
    )
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify(
        {
          musicRoot: libRoot,
          schemaVersion: 3,
          youtubeCookiesPath: path.join(cfgDir, "youtube-cookies.txt"),
        },
        null,
        2,
      ),
      "utf8",
    )
    const { reloadConfigFromDisk } = await import("./musicRootConfig.mjs")
    reloadConfigFromDisk()

    await fs.mkdir(path.join(libRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(libRoot, "Artist", "Album", "cover.jpg"), Buffer.from("jpeg-bytes"))
    await fs.writeFile(
      path.join(libRoot, "Artist", "Album", "kord-trackinfo.json"),
      JSON.stringify({ "01 Song.mp3": { title: "Song" } }),
      "utf8",
    )

    const plan = await buildKordBackupPlan(getAccountsSnapshot)
    const zipNames = new Set(plan.map((e) => e.zipName))
    expect(zipNames.has("kord-db/default_info/theme-bg.webp")).toBe(true)
    expect(zipNames.has("config/youtube-cookies.txt")).toBe(true)
    expect(zipNames.has("libraries/shared/Artist/Album/cover.jpg")).toBe(true)
    expect(zipNames.has("libraries/shared/Artist/Album/kord-trackinfo.json")).toBe(true)
  })

  it("round-trips theme background and library assets through restore", async () => {
    await bootstrapLibrary()
    const { buildKordBackupPlan, restoreKordFromZipPath } = await import("./backupRekord.mjs")
    const { getAccountsSnapshot, CONFIG_FILE } = await import("./musicRootConfig.mjs")
    const { rekordAccountDir } = await import("./rekordDataStore.mjs")

    const accDir = rekordAccountDir(libRoot, "default")
    await fs.mkdir(accDir!, { recursive: true })
    const themeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await fs.writeFile(path.join(accDir!, "theme-bg.png"), themeBytes)
    await fs.writeFile(
      path.join(cfgDir, "youtube-cookies.txt"),
      "# Netscape HTTP Cookie File\n",
      "utf8",
    )
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify(
        {
          musicRoot: libRoot,
          schemaVersion: 3,
          youtubeCookiesPath: path.join(cfgDir, "youtube-cookies.txt"),
        },
        null,
        2,
      ),
      "utf8",
    )
    const { reloadConfigFromDisk } = await import("./musicRootConfig.mjs")
    reloadConfigFromDisk()

    await fs.mkdir(path.join(libRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(libRoot, "Artist", "Album", "cover.png"), Buffer.from("png-data"))

    const plan = await buildKordBackupPlan(getAccountsSnapshot)
    const zipPath = path.join(tmpRoot, "backup.zip")
    await writeZipFromPlan(plan, zipPath)

    await fs.rm(path.join(accDir!, "theme-bg.png"))
    await fs.rm(path.join(cfgDir, "youtube-cookies.txt"))
    await fs.rm(path.join(libRoot, "Artist", "Album", "cover.png"))

    await restoreKordFromZipPath(zipPath)

    const restoredTheme = await fs.readFile(path.join(accDir!, "theme-bg.png"))
    expect(Buffer.compare(restoredTheme, themeBytes)).toBe(0)
    expect(existsSync(path.join(cfgDir, "youtube-cookies.txt"))).toBe(true)
    expect(await fs.readFile(path.join(libRoot, "Artist", "Album", "cover.png"), "utf8")).toBe(
      "png-data",
    )
  })
})
