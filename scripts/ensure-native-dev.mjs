/**
 * Prima di npm run dev: se better-sqlite3 è per un'altra piattaforma o ABI
 * (es. Electron 140 dopo pack, o PE Windows su Linux), ricompila per Node locale.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  canLoadBetterSqliteForSystemNode,
  restoreBetterSqliteForSystemNode,
} from "./rebuild-native-dev.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const nodePath = path.join(
  root,
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
)

function needsDevRebuild() {
  const bsqlDir = path.join(root, "node_modules/better-sqlite3")
  if (!fs.existsSync(bsqlDir)) {
    throw new Error("better-sqlite3 non installato. Esegui prima: npm install")
  }
  if (!fs.existsSync(nodePath)) return true
  return !canLoadBetterSqliteForSystemNode()
}

if (needsDevRebuild()) {
  restoreBetterSqliteForSystemNode()
}
