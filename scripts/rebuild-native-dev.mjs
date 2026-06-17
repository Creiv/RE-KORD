/**
 * Ricompila better-sqlite3 per Node.js di sistema (npm run dev / node server).
 * Dopo pack cross-platform (es. win da Linux) node_modules può contenere un .node
 * per Electron/Windows — questo script ripristina il binario corretto per dev.
 *
 * Nota: `npm rebuild better-sqlite3` non esegue prebuild-install e può segnalare
 * successo senza creare better_sqlite3.node. Usiamo lo stesso flusso del modulo:
 * prebuild-install || node-gyp rebuild --release
 */
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function betterSqliteNodePath() {
  return path.join(
    root,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  )
}

function verifyBetterSqliteNode() {
  const nodePath = betterSqliteNodePath()
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
    if (process.platform === "darwin" && !kind.includes("Mach-O")) {
      throw new Error(`better_sqlite3.node non è Mach-O macOS: ${kind}`)
    }
    console.log(`[rekord] better_sqlite3.node OK: ${kind}`)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      /* `file` non disponibile */
      return
    }
    throw err
  }
}

export function restoreBetterSqliteForSystemNode() {
  const bsqlDir = path.join(root, "node_modules/better-sqlite3")
  if (!fs.existsSync(bsqlDir)) {
    throw new Error("better-sqlite3 non installato. Esegui prima: npm install")
  }

  const buildDir = path.join(bsqlDir, "build")
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true })

  console.log("\n[rekord] better-sqlite3 per Node.js locale (prebuild o compile)…\n")

  let ok = false
  try {
    execSync("npx prebuild-install", { stdio: "inherit", cwd: bsqlDir })
    ok = fs.existsSync(betterSqliteNodePath())
  } catch {
    /* prebuild assente per questa versione Node/arch, prova compile */
  }

  if (!ok) {
    console.log(
      "[rekord] prebuild non disponibile → compilazione da sorgente (serve build-essential su Ubuntu)…",
    )
    try {
      execSync("npx node-gyp rebuild --release", { stdio: "inherit", cwd: bsqlDir })
    } catch (err) {
      throw new Error(
        "Impossibile installare better-sqlite3 per Node.js locale.\n" +
          "Su Ubuntu/Debian:\n" +
          "  sudo apt update && sudo apt install -y build-essential python3\n" +
          "Poi: npm run rebuild:native:dev\n" +
          (err instanceof Error ? `\nDettaglio: ${err.message}` : ""),
      )
    }
  }

  verifyBetterSqliteNode()
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  restoreBetterSqliteForSystemNode()
}
