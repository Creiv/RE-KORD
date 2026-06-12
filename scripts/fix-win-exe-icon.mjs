/**
 * Imposta l'icona di un exe Windows senza wine (resedit, puro JS).
 * Uso: node scripts/fix-win-exe-icon.mjs <exe> <ico>
 * Serve quando si builda la versione Windows da Linux: electron-builder
 * salta l'editing delle risorse exe (richiederebbe wine) e l'eseguibile
 * resterebbe con l'icona di default di Electron.
 */
import fs from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { NtExecutable, NtExecutableResource, Data, Resource } = require("resedit")

const [, , exePath, icoPath] = process.argv
if (!exePath || !icoPath) {
  console.error("Uso: node scripts/fix-win-exe-icon.mjs <exe> <ico>")
  process.exit(1)
}

const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
const res = NtExecutableResource.from(exe)
const iconFile = Data.IconFile.from(fs.readFileSync(icoPath))

const groups = Resource.IconGroupEntry.fromEntries(res.entries)
const groupId = groups.length ? groups[0].id : 1
const lang = groups.length ? groups[0].lang : 1033

Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  groupId,
  lang,
  iconFile.icons.map((icon) => icon.data),
)
res.outputResource(exe)
fs.writeFileSync(exePath, Buffer.from(exe.generate()))
console.log(`Icona RE-KORD incorporata in: ${exePath}`)
