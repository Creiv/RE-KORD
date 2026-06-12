/**
 * Esempio: node scripts/pack-android.mjs 3.5.0
 * Da npm:   npm run pack:android:client -- 3.5.0
 * Sincronizza la shell Capacitor, builda l'APK (debug) e lo copia in
 * release/RE-KORD-Client-<versione>-android.apk come gli altri pacchetti.
 */
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkgPath = path.join(root, "package.json")
const [, , vArg] = process.argv

let pkgVersion = "1.0.0"
try {
  pkgVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || pkgVersion
} catch {
  /* keep fallback for broken local package.json */
}

let version = vArg && String(vArg).trim() ? String(vArg).trim() : pkgVersion
const segs = version.split(".")
if (segs.length === 2) version = `${version}.0`

execSync("npx cap sync android", { stdio: "inherit", cwd: root })

const androidDir = path.join(root, "android")
execSync("./gradlew assembleDebug", { stdio: "inherit", cwd: androidDir })

const apkSrc = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
)
if (!fs.existsSync(apkSrc)) {
  console.error(`APK non trovato: ${apkSrc}`)
  process.exit(1)
}

const releaseDir = path.join(root, "release")
fs.mkdirSync(releaseDir, { recursive: true })
const apkDest = path.join(releaseDir, `RE-KORD-Client-${version}-android.apk`)
fs.copyFileSync(apkSrc, apkDest)
console.log(`\nAPK pronto: ${path.relative(root, apkDest)}`)
