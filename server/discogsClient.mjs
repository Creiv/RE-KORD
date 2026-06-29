import { getDiscogsToken } from "./musicRootConfig.mjs"
import { rekordApiUserAgentWithUrl } from "./rekordVersion.mjs"

const BASE = "https://api.discogs.com"
const UA = rekordApiUserAgentWithUrl()

const MIN_GAP_MS_AUTH = 1100
const MIN_GAP_MS_FREE = 2500
const MAX_429_RETRIES = 3

let lastRequestAt = 0
/** @type {Promise<unknown>} */
let fetchQueue = Promise.resolve()

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueueDiscogsRequest(fn) {
  const run = fetchQueue.then(fn, fn)
  fetchQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Discogs è sempre disponibile: API pubblica senza token, o autenticata se configurato. */
export function isDiscogsConfigured() {
  return true
}

async function waitForRateGap() {
  const token = getDiscogsToken()
  const gap = token ? MIN_GAP_MS_AUTH : MIN_GAP_MS_FREE
  const now = Date.now()
  const wait = gap - (now - lastRequestAt)
  if (wait > 0) await sleep(wait)
}

/**
 * @param {string} path e.g. `/releases/123`
 * @param {{ method?: string, query?: Record<string, string | number | undefined> }} [opts]
 */
async function discogsFetchOnce(path, opts = {}) {
  const token = getDiscogsToken()

  await waitForRateGap()

  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`)
  const query = opts.query || {}
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).trim() !== "") url.searchParams.set(k, String(v))
  }

  /** @type {Record<string, string>} */
  const headers = {
    "User-Agent": UA,
    Accept: "application/vnd.discogs.v2.discogs+json",
  }
  if (token) {
    headers.Authorization = `Discogs token=${token}`
  }

  const r = await fetch(url.toString(), {
    method: opts.method || "GET",
    headers,
  })
  lastRequestAt = Date.now()

  if (r.status === 401) {
    const err = new Error("Discogs token invalid or expired")
    err.code = "DISCOGS_UNAUTHORIZED"
    throw err
  }
  if (r.status === 429) {
    const err = new Error("Discogs rate limit exceeded")
    err.code = "DISCOGS_RATE_LIMIT"
    const retryAfterSec = Number(r.headers.get("Retry-After"))
    err.retryAfterMs =
      Number.isFinite(retryAfterSec) && retryAfterSec >= 0
        ? retryAfterSec * 1000
        : 3000
    throw err
  }
  if (!r.ok) {
    let msg = `Discogs ${r.status}`
    try {
      const j = await r.json()
      if (j?.message) msg = String(j.message)
    } catch {
      /* ignore */
    }
    const err = new Error(msg)
    err.code = "DISCOGS_HTTP"
    err.status = r.status
    throw err
  }

  return r.json()
}

/**
 * @param {string} path e.g. `/releases/123`
 * @param {{ method?: string, query?: Record<string, string | number | undefined> }} [opts]
 */
export async function discogsFetch(path, opts = {}) {
  return enqueueDiscogsRequest(async () => {
    let lastErr = null
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
      try {
        return await discogsFetchOnce(path, opts)
      } catch (err) {
        lastErr = err
        if (err?.code !== "DISCOGS_RATE_LIMIT" || attempt >= MAX_429_RETRIES) throw err
        await sleep(Math.max(500, Number(err.retryAfterMs) || 3000))
      }
    }
    throw lastErr
  })
}

/** Validate token against Discogs identity endpoint. */
export async function validateDiscogsToken(token) {
  return enqueueDiscogsRequest(async () => {
    const t = String(token || "").trim()
    if (!t) {
      const err = new Error("Token is empty")
      err.code = "EMPTY"
      throw err
    }

    await waitForRateGap()

    const r = await fetch(`${BASE}/oauth/identity`, {
      headers: {
        Authorization: `Discogs token=${t}`,
        "User-Agent": UA,
        Accept: "application/vnd.discogs.v2.discogs+json",
      },
    })
    lastRequestAt = Date.now()

    if (r.status === 401) {
      const err = new Error("Discogs token invalid")
      err.code = "DISCOGS_UNAUTHORIZED"
      throw err
    }
    if (!r.ok) {
      const err = new Error(`Discogs validation failed (${r.status})`)
      err.code = "DISCOGS_HTTP"
      throw err
    }
    return r.json()
  })
}

/** @internal test hook */
export function resetDiscogsClientForTests() {
  lastRequestAt = 0
  fetchQueue = Promise.resolve()
}
