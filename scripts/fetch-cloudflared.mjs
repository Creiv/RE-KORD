import { createWriteStream } from "node:fs"
import { chmod, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "server", "bin")

const argPlat = process.argv[2]
const releaseTag =
  process.argv[3] && String(process.argv[3]).trim() !== ""
    ? String(process.argv[3]).trim()
    : null

const platform = argPlat
  ? String(argPlat).toLowerCase()
  : process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux"

if (!new Set(["win", "linux", "mac"]).has(platform)) {
  console.error("Uso: node scripts/fetch-cloudflared.mjs <win|linux|mac> [versione-optional]")
  process.exit(1)
}

const assetName =
  platform === "win"
    ? "cloudflared-windows-amd64.exe"
    : platform === "mac"
      ? process.arch === "arm64"
        ? "cloudflared-darwin-arm64.tgz"
        : "cloudflared-darwin-amd64.tgz"
      : process.arch === "arm64"
        ? "cloudflared-linux-arm64"
        : "cloudflared-linux-amd64"

const destName = platform === "win" ? "cloudflared.exe" : "cloudflared"

const FETCH_TIMEOUT_MS = 10 * 60 * 1000
const MIN_BYTES = 1_000_000

async function existingBinaryOk(dest) {
  try {
    const st = await stat(dest)
    return st.isFile() && st.size >= MIN_BYTES
  } catch {
    return false
  }
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "rekord-cloudflared-fetch",
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token && String(token).trim()) {
    headers.Authorization = `Bearer ${String(token).trim()}`
  }
  return headers
}

async function githubApi(url) {
  const r = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error(`GitHub API: ${r.status} ${r.statusText}`)
  return r.json()
}

function pickAsset(assets, name) {
  const a = assets.find((x) => x && x.name === name)
  if (a) return a
  throw new Error(`Nessun asset "${name}" nella release`)
}

async function downloadToFile(url, dest) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`Download fallito: ${r.status} ${r.statusText}`)
  if (!r.body) throw new Error("Download senza body")
  const tmp = `${dest}.download`
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp))
  const st = await stat(tmp)
  if (st.size < MIN_BYTES) {
    throw new Error(`File scaricato sospettosamente piccolo (${st.size} byte).`)
  }
  const { rename } = await import("node:fs/promises")
  await rename(tmp, dest)
}

async function main() {
  if (platform === "mac") {
    throw new Error("Asset cloudflared mac in formato .tgz non supportato da questo script.")
  }

  await mkdir(outDir, { recursive: true })
  const dest = path.join(outDir, destName)

  if (process.env.REKORD_SKIP_CLOUDFLARED_FETCH === "1") {
    if (await existingBinaryOk(dest)) {
      console.log(
        `Skip fetch (REKORD_SKIP_CLOUDFLARED_FETCH): ${path.relative(root, dest)} già presente`,
      )
      return
    }
    console.warn(
      "REKORD_SKIP_CLOUDFLARED_FETCH=1 ma il binario manca o è troppo piccolo; continuo il download.",
    )
  }

  if (await existingBinaryOk(dest)) {
    console.log(`Già presente, skip: ${path.relative(root, dest)}`)
    return
  }

  const relUrl = releaseTag
    ? `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${releaseTag}`
    : "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"

  let data
  try {
    data = await githubApi(relUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/403|rate limit/i.test(msg) && (await existingBinaryOk(dest))) {
      console.warn(
        `GitHub rate limit; uso binario esistente: ${path.relative(root, dest)}`,
      )
      return
    }
    throw err
  }

  const assets = data.assets || []
  const asset = pickAsset(assets, assetName)
  console.log(`Scarico ${asset.name} -> ${path.relative(root, dest)} (può richiedere alcuni minuti)`)
  await downloadToFile(asset.browser_download_url, dest)
  if (platform !== "win") await chmod(dest, 0o755)
  console.log("OK")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
