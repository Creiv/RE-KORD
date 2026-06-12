/**
 * Esempio: node scripts/pack-release.mjs server linux 3.5.0
 * Da npm:   npm run pack:linux:server -- 3.5.0
 */
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const configPath = path.join(root, "electron-builder.rekord.cjs")
const pkgPath = path.join(root, "package.json")
const [, , flavor, platform, vArg] = process.argv
const platforms = new Set(["linux", "win", "mac"])
const flavors = new Set(["server", "client"])

if (!flavors.has(flavor) || !platforms.has(platform)) {
  console.error(
    "Uso: node scripts/pack-release.mjs <server|client> <linux|win|mac> [versione]\n" +
      "Esempio: npm run pack:linux:server -- 3.5.0",
  )
  process.exit(1)
}

let pkgVersion = "1.0.0"
try {
  pkgVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || pkgVersion
} catch {
  /* keep fallback for broken local package.json */
}

let version = vArg && String(vArg).trim() ? String(vArg).trim() : pkgVersion
const segs = version.split(".")
if (segs.length === 2) version = `${version}.0`

const platFlag = platform === "win" ? "--win" : platform === "mac" ? "--mac" : "--linux"
process.env.REKORD_PACK_FLAVOR = flavor
process.env.REKORD_APP_VERSION = version

if (flavor === "server") {
  execSync("npm run build", { stdio: "inherit", cwd: root })
  execSync(`node ${path.join(root, "scripts", "fetch-ytdlp.mjs")} ${platform}`, {
    stdio: "inherit",
    cwd: root,
  })
  execSync(`node ${path.join(root, "scripts", "fetch-cloudflared.mjs")} ${platform}`, {
    stdio: "inherit",
    cwd: root,
  })
}

execSync(`npx electron-builder ${platFlag} --config ${configPath}`, {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, REKORD_PACK_FLAVOR: flavor, REKORD_APP_VERSION: version },
})

// Build Windows da host non-Windows: electron-builder salta l'editing
// dell'exe (servirebbe wine) → icona incorporata a posteriori con resedit
// e archivio 7z ricreato con l'eseguibile corretto.
if (platform === "win" && process.platform !== "win32") {
  const productName = flavor === "client" ? "RE-KORD Client" : "RE-KORD Server"
  const unpackedDir = path.join(root, "release", "win-unpacked")
  const exePath = path.join(unpackedDir, `${productName}.exe`)
  if (fs.existsSync(exePath)) {
    execSync(
      `node "${path.join(root, "scripts", "fix-win-exe-icon.mjs")}" "${exePath}" "${path.join(root, "public", "icon.ico")}"`,
      { stdio: "inherit", cwd: root },
    )
    const artifact = path.join(
      root,
      "release",
      `RE-KORD-${flavor === "client" ? "Client" : "Server"}-${version}-win-x64.7z`,
    )
    const { path7za } = await import("7zip-bin")
    fs.rmSync(artifact, { force: true })
    execSync(`"${path7za}" a "${artifact}" .`, {
      stdio: "inherit",
      cwd: unpackedDir,
    })
    console.log(`\nArchivio rigenerato con icona corretta: ${artifact}`)
  } else {
    console.warn(`Exe non trovato per fix icona: ${exePath}`)
  }
}
