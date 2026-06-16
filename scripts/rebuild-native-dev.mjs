/**
 * Ricompila better-sqlite3 per Node.js di sistema (npm run dev / node server).
 * Dopo pack cross-platform (es. win da Linux) node_modules può contenere un .node
 * per Electron/Windows — questo script ripristina il binario corretto per dev.
 */
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

export function restoreBetterSqliteForSystemNode() {
  const buildDir = path.join(root, "node_modules/better-sqlite3/build")
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true })
  console.log("\n[rekord] rebuild better-sqlite3 per Node.js locale (dev)…\n")
  execSync("npm rebuild better-sqlite3", { stdio: "inherit", cwd: root })
  const nodePath = path.join(buildDir, "Release/better_sqlite3.node")
  if (!fs.existsSync(nodePath)) {
    throw new Error(`better_sqlite3.node mancante dopo rebuild dev: ${nodePath}`)
  }
  try {
    const kind = execSync(`file -b "${nodePath}"`, { encoding: "utf8", cwd: root }).trim()
    if (process.platform === "linux" && !kind.includes("ELF")) {
      throw new Error(`better_sqlite3.node non è ELF Linux: ${kind}`)
    }
    if (process.platform === "win32" && !kind.includes("PE32") && !kind.includes("MS Windows")) {
      throw new Error(`better_sqlite3.node non è PE Windows: ${kind}`)
    }
    console.log(`[rekord] better_sqlite3.node OK: ${kind}`)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      /* file non disponibile su alcuni host */
      return
    }
    throw err
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  restoreBetterSqliteForSystemNode()
}
