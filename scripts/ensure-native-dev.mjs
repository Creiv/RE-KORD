/**
 * Prima di npm run dev: se better-sqlite3 è per un'altra piattaforma (es. PE dopo pack win),
 * ricompila automaticamente per Node.js locale.
 */
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { restoreBetterSqliteForSystemNode } from "./rebuild-native-dev.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const nodePath = path.join(
  root,
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
)

function needsDevRebuild() {
  if (!fs.existsSync(nodePath)) return true
  try {
    const kind = execSync(`file -b "${nodePath}"`, { encoding: "utf8", cwd: root }).trim()
    if (process.platform === "linux") return !kind.includes("ELF")
    if (process.platform === "win32") {
      return !kind.includes("PE32") && !kind.includes("MS Windows")
    }
    if (process.platform === "darwin") return !kind.includes("Mach-O")
  } catch {
    return true
  }
  return false
}

if (needsDevRebuild()) {
  restoreBetterSqliteForSystemNode()
}
