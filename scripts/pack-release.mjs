/**
 * Esempio: node scripts/pack-release.mjs server linux 5.0.0
 * Da npm:   npm run pack:linux:server -- 5.0.0
 * (senza versione esplicita usa quella di package.json)
 */
import { execFileSync, execSync } from "node:child_process"
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
      "Esempio: npm run pack:linux:server -- 5.0.0",
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

function electronVersionFromPkg() {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const raw = pkg.devDependencies?.electron || pkg.dependencies?.electron || ""
    const m = String(raw).match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : "39.0.0"
  } catch {
    return "39.0.0"
  }
}

function packHostPlatform() {
  if (process.platform === "win32") return "win"
  if (process.platform === "darwin") return "mac"
  return "linux"
}

function isCrossCompile(targetPlatform) {
  return packHostPlatform() !== targetPlatform
}

function electronOsName(targetPlatform) {
  if (targetPlatform === "win") return "win32"
  if (targetPlatform === "mac") return "darwin"
  return "linux"
}

function betterSqliteNodeInTree(baseDir) {
  return path.join(
    baseDir,
    "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  )
}

function unpackedDirForPlatform(targetPlatform) {
  if (targetPlatform === "win") return path.join(root, "release", "win-unpacked")
  if (targetPlatform === "mac") return path.join(root, "release", "mac")
  return path.join(root, "release", "linux-unpacked")
}

function nativeRebuildEnv(targetPlatform) {
  const env = { ...process.env }
  const os = electronOsName(targetPlatform)
  env.npm_config_target_platform = os
  env.npm_config_target_arch = "x64"
  env.npm_config_arch = "x64"
  env.npm_config_runtime = "electron"
  env.npm_config_target = electronVersionFromPkg()
  env.npm_config_disturl = "https://electronjs.org/headers"
  return env
}

function rmBetterSqliteBuildDir() {
  const bsqlBuildDir = path.join(root, "node_modules/better-sqlite3/build")
  if (fs.existsSync(bsqlBuildDir)) fs.rmSync(bsqlBuildDir, { recursive: true, force: true })
}

/** Scarica il prebuild Electron (win/mac) senza compilare sul host Linux. */
function fetchPrebuiltBetterSqlite(targetPlatform, electronVer) {
  const os = electronOsName(targetPlatform)
  const bsqlDir = path.join(root, "node_modules/better-sqlite3")
  rmBetterSqliteBuildDir()
  console.log(
    `\n[pack] prebuild-install ${os}/x64 (Electron ${electronVer}) per better-sqlite3\n`,
  )
  execSync(
    `npx prebuild-install --platform=${os} --arch=x64 -r electron -t ${electronVer}`,
    { stdio: "inherit", cwd: bsqlDir, env: nativeRebuildEnv(targetPlatform) },
  )
}

/** better-sqlite3 deve matchare l'ABI di Electron (server child con ELECTRON_RUN_AS_NODE). */
function rebuildNativeForElectron(targetPlatform) {
  const electronVer = electronVersionFromPkg()
  if (isCrossCompile(targetPlatform)) {
    fetchPrebuiltBetterSqlite(targetPlatform, electronVer)
    try {
      verifyBetterSqliteNative(targetPlatform)
    } catch (err) {
      console.warn(
        `[pack] prebuild in node_modules non verificato (${err instanceof Error ? err.message : err}); electron-builder ricompilerà nel pacchetto`,
      )
    }
    return
  }
  const env = nativeRebuildEnv(targetPlatform)
  rmBetterSqliteBuildDir()
  console.log(
    `\n[pack] electron-rebuild per ${env.npm_config_target_platform}/${env.npm_config_target_arch} (Electron ${electronVer}): better-sqlite3\n`,
  )
  runElectronRebuild(electronVer, env, false)
  try {
    verifyBetterSqliteNative(targetPlatform)
  } catch {
    console.log("[pack] rebuild prebuilt errato, riprovo --build-from-source…")
    rmBetterSqliteBuildDir()
    runElectronRebuild(electronVer, env, true)
    verifyBetterSqliteNative(targetPlatform)
  }
}

function runElectronRebuild(electronVer, env, fromSource) {
  const srcFlag = fromSource ? " --build-from-source" : ""
  const cmd = `npx @electron/rebuild --version=${electronVer} -f${srcFlag} -w better-sqlite3`
  try {
    execSync(cmd, { stdio: "inherit", cwd: root, env })
  } catch (err) {
    const nodePath = path.join(
      root,
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    )
    if (fs.existsSync(nodePath)) {
      console.warn(
        "[pack] electron-rebuild ha segnalato errore ma better_sqlite3.node esiste; verifico architettura…",
      )
      return
    }
    throw err
  }
}

function verifyBetterSqliteNative(targetPlatform, nodePath = path.join(
    root,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  )) {
  if (!fs.existsSync(nodePath)) {
    throw new Error(`better_sqlite3.node mancante dopo rebuild: ${nodePath}`)
  }
  const header = Buffer.alloc(4096)
  const fd = fs.openSync(nodePath, "r")
  let bytesRead = 0
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  let kind = "unknown"
  if (bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    kind = "linux"
  } else if (bytesRead >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c)
    if (
      peOffset + 4 <= bytesRead &&
      header.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
    ) kind = "win"
  } else if (bytesRead >= 4) {
    const magic = header.readUInt32BE(0)
    if (new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]).has(magic)) {
      kind = "mac"
    }
  }
  if (kind !== targetPlatform) {
    throw new Error(
      `better_sqlite3.node ha architettura errata per target "${targetPlatform}": ${kind}`,
    )
  }
  console.log(`[pack] better_sqlite3.node OK: formato ${kind}`)
}

function verifyUnpackedBetterSqlite(targetPlatform) {
  const unpackedDir = unpackedDirForPlatform(targetPlatform)
  const nodePath = betterSqliteNodeInTree(unpackedDir)
  console.log(`\n[pack] verifica better-sqlite3 nel pacchetto: ${nodePath}`)
  verifyBetterSqliteNative(targetPlatform, nodePath)
}

const platFlag = platform === "win" ? "--win" : platform === "mac" ? "--mac" : "--linux"
const packageSmoke = process.env.REKORD_PACK_SMOKE === "1"
process.env.REKORD_PACK_FLAVOR = flavor
process.env.REKORD_APP_VERSION = version

if (flavor === "server") {
  execSync("npm run build", { stdio: "inherit", cwd: root })
  if (!packageSmoke) {
    execFileSync(process.execPath, [path.join(root, "scripts", "fetch-ytdlp.mjs"), platform], {
      stdio: "inherit",
      cwd: root,
    })
    execFileSync(process.execPath, [path.join(root, "scripts", "fetch-cloudflared.mjs"), platform], {
      stdio: "inherit",
      cwd: root,
    })
  }
  rebuildNativeForElectron(platform)
}

execSync(`npx electron-builder ${platFlag} ${packageSmoke ? "--dir" : ""} --config ${configPath}`, {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, REKORD_PACK_FLAVOR: flavor, REKORD_APP_VERSION: version },
})

if (flavor === "server") {
  verifyUnpackedBetterSqlite(platform)
}

if (packageSmoke && flavor === "server" && !isCrossCompile(platform)) {
  const unpackedDir = unpackedDirForPlatform(platform)
  const executable =
    platform === "win"
      ? path.join(unpackedDir, "RE-KORD Server.exe")
      : platform === "mac"
        ? path.join(unpackedDir, "RE-KORD Server.app", "Contents", "MacOS", "RE-KORD Server")
        : path.join(unpackedDir, "rekord")
  if (!fs.existsSync(executable)) {
    throw new Error(`Eseguibile smoke test non trovato: ${executable}`)
  }
  const command =
    platform === "linux" && !process.env.DISPLAY ? "xvfb-run" : executable
  const args =
    command === "xvfb-run" ? ["-a", executable, "--package-smoke"] : ["--package-smoke"]
  console.log(`\n[pack] smoke test pacchetto: ${executable}\n`)
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: unpackedDir,
    timeout: 90_000,
    env: { ...process.env, REKORD_ELECTRON_LOG: "1" },
  })
}

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

if (isCrossCompile(platform)) {
  const { restoreBetterSqliteForSystemNode } = await import("./rebuild-native-dev.mjs")
  console.log("\n[pack] ripristino better-sqlite3 per npm run dev sul host locale…")
  restoreBetterSqliteForSystemNode()
}
