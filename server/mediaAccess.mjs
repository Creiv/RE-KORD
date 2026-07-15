/**
 * Gate pragmatico per /media: loopback fidato, client LAN/remote con account valido
 * e brano incluso nella selezione libreria dell'account.
 */
import { findAccountById, getMusicRoot } from "./musicRootConfig.mjs"
import {
  isDockerGatewayAddress,
  isLoopbackAddress,
} from "./requestAccess.mjs"
import { getLibraryEpoch } from "./db/index.mjs"
import { getLibraryIndex } from "./libraryIndexService.mjs"
import {
  filterLibraryIndexBySelection,
  getSelectionFilterMode,
  readLibrarySelection,
} from "./librarySelection.mjs"

/** @param {import("express").Request} req */
function getClientAddress(req) {
  const raw = String(
    req.socket?.remoteAddress || req.connection?.remoteAddress || "",
  )
  return raw.replace(/^::ffff:/, "")
}

/** @param {import("express").Request} req */
export function isTrustedMediaClient(req) {
  const addr = getClientAddress(req)
  if (isLoopbackAddress(addr)) return true
  if (process.env.REKORD_DOCKER === "1" && isDockerGatewayAddress(addr)) {
    return true
  }
  return false
}

/** @type {Map<string, Set<string> | "ALL">} */
const trackAllowCache = new Map()
const TRACK_ALLOW_CACHE_MAX = 12

function rememberTrackAllow(key, value) {
  if (trackAllowCache.size >= TRACK_ALLOW_CACHE_MAX) {
    const oldest = trackAllowCache.keys().next().value
    if (oldest) trackAllowCache.delete(oldest)
  }
  trackAllowCache.set(key, value)
}

/** @param {import("express").Request} req */
function resolveExplicitAccountId(req) {
  const fromQuery = String(req.query?.accountId || "").trim()
  const fromHeader = String(
    req.headers["x-rekord-account-id"] ||
      req.headers["x-kord-account-id"] ||
      "",
  ).trim()
  return fromQuery || fromHeader || null
}

async function loadAllowedTrackSet(accountId) {
  const root = getMusicRoot()
  if (!root) return new Set()
  let epoch = 0
  try {
    epoch = getLibraryEpoch(root)
  } catch {
    return new Set()
  }
  const cacheKey = `${accountId}:${epoch}`
  const hit = trackAllowCache.get(cacheKey)
  if (hit) return hit

  const selection = await readLibrarySelection(root, accountId)
  const mode = getSelectionFilterMode(selection, accountId)
  if (mode === "all") {
    rememberTrackAllow(cacheKey, "ALL")
    return "ALL"
  }
  if (mode === "empty") {
    const empty = new Set()
    rememberTrackAllow(cacheKey, empty)
    return empty
  }

  const index = await getLibraryIndex(root)
  const filtered = filterLibraryIndexBySelection(index, selection, accountId)
  const allowed = new Set(filtered.tracks.map((track) => track.relPath))
  rememberTrackAllow(cacheKey, allowed)
  return allowed
}

/**
 * @param {import("express").Request} req
 * @param {string} mediaRelPath percorso relativo risolto sotto music root
 * @returns {Promise<{ ok: true } | { ok: false, status: number }>}
 */
export async function validateMediaAccess(req, mediaRelPath) {
  if (isTrustedMediaClient(req)) return { ok: true }

  const accountId = resolveExplicitAccountId(req)
  if (!accountId || !findAccountById(accountId)) {
    return { ok: false, status: 403 }
  }

  const allowed = await loadAllowedTrackSet(accountId)
  if (allowed === "ALL") return { ok: true }
  if (!allowed.has(mediaRelPath)) {
    return { ok: false, status: 403 }
  }
  return { ok: true }
}

/** Solo test: svuota cache gate media. */
export function resetMediaAccessCacheForTests() {
  trackAllowCache.clear()
}
