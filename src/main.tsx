import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setSelectedAccountId } from "./lib/api"
import { migrateLegacyStorageKeys } from "./lib/migrateLegacyNaming"

migrateLegacyStorageKeys()
import { applyColorMixCompatDataset } from "./lib/cssColorMix"
import { isStandaloneDisplayMode } from "./lib/routing"

applyColorMixCompatDataset()

const u = new URLSearchParams(window.location.search)
const urlClientEmbed = u.get("rekordClient") === "1"
function detectClientEmbed(): boolean {
  if (urlClientEmbed) return true
  try {
    if (sessionStorage.getItem("rekord-embed") === "client") return true
  } catch {
    /* ignore */
  }
  const w = window as unknown as { RekordMediaNative?: { update?: unknown } }
  return typeof w.RekordMediaNative?.update === "function"
}
const clientEmbed = detectClientEmbed()
const fromUrlAccount = String(u.get("accountId") ?? "").trim()
const electronAccount =
  clientEmbed ? String(u.get("rekordAccount") ?? "").trim() : ""
const bootstrapAccount = fromUrlAccount || electronAccount
if (bootstrapAccount) {
  try {
    setSelectedAccountId(bootstrapAccount)
    if (clientEmbed) {
      sessionStorage.setItem("rekord-embed", "client")
    }
  } catch {
    /* ignore */
  }
}
if (isStandaloneDisplayMode()) {
  document.documentElement.dataset.portraitLock = "1"
}

if (clientEmbed) {
  document.documentElement.dataset.rekordClient = "1"
  u.delete("rekordClient")
  u.delete("rekordAccount")
  const qAid = String(u.get("accountId") ?? "").trim()
  if (!qAid && bootstrapAccount) u.set("accountId", bootstrapAccount)
  const q = u.toString()
  const next = `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash || ""}`
  window.history.replaceState(null, document.title, next)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* install prompt stays unavailable if registration fails */
    })
  })
}
