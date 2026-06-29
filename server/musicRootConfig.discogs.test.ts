import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ENV_KEYS = ["REKORD_USER_CONFIG_DIR", "REKORD_DISCOGS_TOKEN"] as const

describe("musicRootConfig discogs token", () => {
  let tmpDir = ""

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-discogs-cfg-"))
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.REKORD_USER_CONFIG_DIR = tmpDir
    vi.resetModules()
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("persists token to discogs-token file", async () => {
    const mod = await import("./musicRootConfig.mjs")
    await mod.setPersistedDiscogsToken("secret-token-abc")
    expect(mod.getDiscogsToken()).toBe("secret-token-abc")
    const snap = mod.getConfigSnapshot(false)
    expect(snap.discogsTokenConfigured).toBe(true)
    expect(snap.discogsConfigured).toBe(true)
    expect(snap.discogsLockedByEnv).toBe(false)
  })

  it("reads token from environment", async () => {
    process.env.REKORD_DISCOGS_TOKEN = "env-token"
    vi.resetModules()
    const mod = await import("./musicRootConfig.mjs")
    expect(mod.getDiscogsToken()).toBe("env-token")
    expect(mod.getConfigSnapshot(false).discogsLockedByEnv).toBe(true)
  })

  it("clears persisted token", async () => {
    const mod = await import("./musicRootConfig.mjs")
    await mod.setPersistedDiscogsToken("to-clear")
    await mod.clearPersistedDiscogsToken()
    expect(mod.getDiscogsToken()).toBeNull()
    expect(mod.getConfigSnapshot(false).discogsTokenConfigured).toBe(false)
    expect(mod.getConfigSnapshot(false).discogsConfigured).toBe(true)
  })

  it("enables discogs metadata without token", async () => {
    const mod = await import("./musicRootConfig.mjs")
    const snap = mod.getConfigSnapshot(false)
    expect(snap.discogsTokenConfigured).toBe(false)
    expect(snap.discogsConfigured).toBe(true)
  })
})
