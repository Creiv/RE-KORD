import type { UserStateV1 } from "../../types"

type Wrapped<T> = { ok: boolean; data: T; error: string | null }
import { migrateLegacyStorageKeys } from "../migrateLegacyNaming"

const SESSION_ACCOUNT_STORAGE_KEY = "rekord-session-account-id"
const LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY = "rekord-active-account-id"
const LEGACY_KORD_SESSION_KEY = "kord-session-account-id"
const LEGACY_KORD_ACTIVE_KEY = "kord-active-account-id"
let accountBootstrapPromise: Promise<string | null> | null = null
let accountBootstrapBackoffUntil = 0
let accountSessionValidated = false
export const ACCOUNT_BOOTSTRAP_BACKOFF_MS = 8000
export const API_UNREACHABLE_BACKOFF_MS = 12000
let apiUnreachableUntil = 0

/** Thrown when the KORD API cannot be reached or returns a non-JSON proxy error. */
export class BackendUnreachableError extends Error {
  constructor() {
    super("BACKEND_UNREACHABLE")
    this.name = "BackendUnreachableError"
  }
}

export function markApiUnreachable() {
  apiUnreachableUntil = Date.now() + API_UNREACHABLE_BACKOFF_MS
}

/** Clears API/account bootstrap backoffs so resume/online handlers can retry immediately. */
export function resetBackendConnectivityState() {
  apiUnreachableUntil = 0
  accountBootstrapBackoffUntil = 0
  accountBootstrapPromise = null
}

/** Lightweight reachability check; bypasses assertApiReachable backoff. */
export async function probeBackendHealth(timeoutMs = 6000): Promise<boolean> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(apiUrl("/api/health"), {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

export function assertApiReachable() {
  if (Date.now() < apiUnreachableUntil) {
    throw new BackendUnreachableError()
  }
}

/** @internal Test hook for unreachable backoff window. */
export function getApiUnreachableUntilForTests(): number {
  return apiUnreachableUntil
}

/** True when the KORD API is unreachable (server stopped, proxy down, offline). */
export function isBackendUnreachableError(err: unknown): boolean {
  if (err instanceof BackendUnreachableError) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    /failed to fetch|networkerror|load failed|network request failed|econnrefused|enotfound|etimedout|502|503|504|bad gateway|service unavailable|proxy error|unexpected end of json|json\.parse|invalid_api_json|backend_unreachable|empty_response/i.test(
      msg,
    ) || (err instanceof TypeError && msg.includes("fetch"))
  )
}

export async function readResponseJson<T>(response: Response): Promise<T> {
  let text: string
  try {
    text = await response.text()
  } catch {
    markApiUnreachable()
    throw new BackendUnreachableError()
  }
  if (!text.trim()) {
    if (!response.ok) {
      markApiUnreachable()
      throw new BackendUnreachableError()
    }
    throw new Error("EMPTY_RESPONSE")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as T
  } catch {
    if (!response.ok) {
      markApiUnreachable()
      throw new BackendUnreachableError()
    }
    throw new SyntaxError("INVALID_API_JSON")
  }
  if (
    !response.ok &&
    (response.status === 502 ||
      response.status === 503 ||
      response.status === 504)
  ) {
    const apiErr =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: string }).error === "string"
        ? (parsed as { error: string }).error.trim()
        : ""
    if (apiErr) throw new Error(apiErr)
    markApiUnreachable()
    throw new BackendUnreachableError()
  }
  return parsed as T
}

export class UserStateRevisionConflict extends Error {
  readonly currentState: UserStateV1
  constructor(currentState: UserStateV1) {
    super("USER_STATE_REVISION_CONFLICT")
    this.name = "UserStateRevisionConflict"
    this.currentState = currentState
  }
}

export async function unwrapUserStateMutation(response: Response): Promise<UserStateV1> {
  const parsed = await readResponseJson<
    | Wrapped<UserStateV1>
    | {
        error?: string
        details?: { code?: string; currentState?: UserStateV1 }
      }
  >(response)
  if (response.status === 409) {
    const detail = parsed && typeof parsed === "object" ? (parsed as { details?: { currentState?: UserStateV1 } }).details : undefined
    const cur = detail?.currentState
    if (cur && typeof cur === "object") {
      throw new UserStateRevisionConflict(cur)
    }
    throw new Error("USER_STATE_REVISION_CONFLICT")
  }
  if (!response.ok) {
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: string }).error === "string") {
      throw new Error((parsed as { error: string }).error)
    }
    throw new Error("Request failed")
  }
  const json = parsed as Wrapped<UserStateV1>
  if ("ok" in json && "data" in json) {
    if (!json.ok) throw new Error(json.error || "Request failed")
    return json.data
  }
  return parsed as UserStateV1
}

export async function unwrap<T>(response: Response): Promise<T> {
  const json = await readResponseJson<T | Wrapped<T> | { error?: string }>(response)
  if (!response.ok) {
    if (json && typeof json === "object" && "error" in json && typeof json.error === "string") {
      throw new Error(json.error)
    }
    throw new Error("Request failed")
  }
  if (json && typeof json === "object" && "ok" in json && "data" in json) {
    const wrapped = json as Wrapped<T>
    if (!wrapped.ok) throw new Error(wrapped.error || "Request failed")
    return wrapped.data
  }
  return json as T
}

export function getSelectedAccountId(): string | null {
  try {
    migrateLegacyStorageKeys()
    return (
      localStorage.getItem(SESSION_ACCOUNT_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_KORD_SESSION_KEY) ||
      localStorage.getItem(LEGACY_KORD_ACTIVE_KEY) ||
      null
    )
  } catch {
    return null
  }
}

export function setSelectedAccountId(id: string) {
  try {
    migrateLegacyStorageKeys()
    localStorage.setItem(SESSION_ACCOUNT_STORAGE_KEY, id)
    localStorage.removeItem(LEGACY_ACTIVE_ACCOUNT_STORAGE_KEY)
    localStorage.removeItem(LEGACY_KORD_SESSION_KEY)
    localStorage.removeItem(LEGACY_KORD_ACTIVE_KEY)
    accountBootstrapPromise = Promise.resolve(id)
    window.dispatchEvent(new CustomEvent("rekord-account-session-changed"))
  } catch {
    /* ignore */
  }
}

export type RemoteAccessState = {
  enabled: boolean
  status: "stopped" | "starting" | "running" | "error"
  provider: string
  publicUrl: string | null
  error: string | null
  startedAt: string | null
  cloudflaredPath: string
  cloudflareLoggedIn: boolean
}

export type Account = {
  id: string
  name: string
}

export type AccountsResponse = {
  defaultAccountId: string
  accounts: Account[]
  lockedByEnv: boolean
  createdAccountId?: string
}

export type AppConfig = {
  musicRoot?: string | null
  lockedByEnv: boolean
  libraryRootConfigured?: boolean
  libraryDataWritable?: boolean
  libraryWriteError?: { code?: string; path?: string; message?: string } | null
  localAccess?: boolean
  remoteTunnelAccess?: boolean
  libraryRootWritable?: boolean
  libraryRootLabel?: string | null
  youtubeCookiesConfigured?: boolean
  youtubeCookiesWritable?: boolean
  youtubeCookiesLockedByEnv?: boolean
  youtubeCookiesLabel?: string | null
  discogsConfigured?: boolean
  discogsTokenConfigured?: boolean
  discogsWritable?: boolean
  discogsLockedByEnv?: boolean
  serverPort: number
  devClientPort: number
  lanAccessUrl: string | null
  defaultAccountId?: string
  remoteAccess?: RemoteAccessState
  transcodeAvailable?: boolean
}

export function rememberAvailableAccount(data: AccountsResponse | AppConfig) {
  try {
    const current = getSelectedAccountId()
    if ("accounts" in data && current) {
      if (data.accounts.some((account) => account.id === current)) return
      const fallback = data.defaultAccountId || data.accounts[0]?.id
      if (fallback && fallback !== current) {
        setSelectedAccountId(fallback)
        window.location.replace(new URL("/", window.location.href).href)
      }
      return
    }
    if (current) return
    const id = "accounts" in data
      ? data.defaultAccountId || data.accounts[0]?.id
      : data.defaultAccountId
    if (id) setSelectedAccountId(id)
  } catch {
    /* ignore */
  }
}

function pathnameOnly(full: string) {
  return full.split(/[?#]/)[0] ?? full
}

function accountHeaders(base: HeadersInit = {}) {
  if (
    base &&
    !Array.isArray(base) &&
    !(base instanceof Headers) &&
    (base as Record<string, string>)["X-KORD-Account-Id"]
  ) {
    return base
  }
  const id = getSelectedAccountId()
  return id ? { ...base, "X-KORD-Account-Id": id } : base
}

function accountHeadersForPath(endpointPath: string, base: HeadersInit = {}) {
  if (pathnameOnly(endpointPath) === "/api/accounts") return base
  return accountHeaders(base)
}

export function apiUrl(path: string, params: Record<string, string> = {}) {
  const qIndex = path.indexOf("?")
  const base = qIndex >= 0 ? path.slice(0, qIndex) : path
  const out = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : "")
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value).trim() !== "") {
      out.set(key, String(value))
    }
  }
  const pname = pathnameOnly(base)
  if (pname !== "/api/accounts") {
    const id = getSelectedAccountId()
    if (id && !out.has("accountId")) out.set("accountId", id)
  }
  const query = out.toString()
  return query ? `${base}?${query}` : base
}

export function apiFetch(
  pathname: string,
  init?: RequestInit,
  query: Record<string, string> = {},
): Promise<Response> {
  const url = apiUrl(pathname, query)
  const hdr = init?.headers
  const pathForHdr = pathnameOnly(pathname.split("?")[0] ?? pathname)
  const nextHeaders =
    hdr !== undefined
      ? accountHeadersForPath(pathForHdr, hdr as HeadersInit)
      : accountHeadersForPath(pathForHdr)
  assertApiReachable()
  return fetch(url, {
    ...init,
    headers: nextHeaders,
  }).catch((err: unknown) => {
    if (isBackendUnreachableError(err)) markApiUnreachable()
    throw err
  })
}

export async function ensureSelectedAccountId(): Promise<string | null> {
  const existing = getSelectedAccountId()
  if (existing && accountSessionValidated) return existing
  if (Date.now() < accountBootstrapBackoffUntil) return existing ?? null
  if (accountBootstrapPromise) return accountBootstrapPromise
  accountBootstrapPromise = apiFetch("/api/accounts", { cache: "no-store" })
    .then((response) => unwrap<AccountsResponse>(response))
    .then((data) => {
      accountSessionValidated = true
      accountBootstrapBackoffUntil = 0
      rememberAvailableAccount(data)
      return getSelectedAccountId()
    })
    .catch(() => {
      accountBootstrapPromise = null
      accountBootstrapBackoffUntil = Date.now() + ACCOUNT_BOOTSTRAP_BACKOFF_MS
      return getSelectedAccountId()
    })
  return accountBootstrapPromise
}

export function mediaUrl(relPath: string, baseUrl?: string | null) {
  const path = `/media/${relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
  const id = getSelectedAccountId()
  const withAccount = id ? `${path}?${new URLSearchParams({ accountId: id })}` : path
  if (!baseUrl) return withAccount
  try {
    return new URL(withAccount, baseUrl).href
  } catch {
    return withAccount
  }
}

export function mediaUrlForTrack(
  track: { relPath: string; filePath?: string | null },
  baseUrl?: string | null,
) {
  return mediaUrl(track.filePath?.trim() || track.relPath, baseUrl)
}

export function coverUrlForTrackRelPath(relPath: string) {
  return apiUrl("/api/cover", { path: relPath })
}

export function coverUrlForTrack(
  track: { relPath: string; filePath?: string | null },
) {
  return coverUrlForTrackRelPath(track.filePath?.trim() || track.relPath)
}

export function coverUrlForAlbumRelPath(relPath: string) {
  return apiUrl("/api/cover", { path: relPath })
}

export function artworkUrl(artworkId: string, size: "128" | "256" | "full" = "128") {
  return apiUrl(`/api/library/artwork/${encodeURIComponent(artworkId)}`, { size })
}
