import type { LibraryEntityDelta } from "../../types"
import { randomUUID } from "../randomUUID"
import type { FetchedAlbumMeta } from "./library"
import {
  type AccountsResponse,
  type AppConfig,
  type RemoteAccessState,
  apiFetch,
  getSelectedAccountId,
  readResponseJson,
  rememberAvailableAccount,
  setSelectedAccountId,
  unwrap,
} from "./core"

export type { AppConfig, RemoteAccessState, Account, AccountsResponse } from "./core"

export type DiagnosticsPayload = {
  version: string
  uptimeMs: number
  libraryRootConfigured: boolean
  libraryWritable?: boolean
  libraryDb?: {
    bootstrapped?: boolean
    epoch?: number
    path?: string
    stats?: { artists: number; albums: number; tracks: number }
  }
  recentErrors?: Array<{ at: string; message: string; context?: string }>
  jobs?: unknown[]
  watchers?: number
  artworkCacheBytes?: number
}

export async function fetchConfig(): Promise<AppConfig> {
  const response = await apiFetch("/api/config")
  const data = await unwrap<AppConfig>(response)
  rememberAvailableAccount(data)
  return data
}

export async function fetchDiagnostics(): Promise<DiagnosticsPayload> {
  const response = await apiFetch("/api/diagnostics", { cache: "no-store" })
  return unwrap<DiagnosticsPayload>(response)
}

export async function fetchServerPublicIp(): Promise<{
  ip: string | null
  cached?: boolean
}> {
  const response = await apiFetch("/api/network/public-ip", { cache: "no-store" })
  return unwrap<{ ip: string | null; cached?: boolean }>(response)
}

export async function fetchRemoteAccessState(): Promise<RemoteAccessState> {
  const response = await apiFetch("/api/remote-access", { cache: "no-store" })
  return unwrap<RemoteAccessState>(response)
}

export async function startRemoteAccess(): Promise<RemoteAccessState> {
  const response = await apiFetch("/api/remote-access/start", {
    method: "POST",
  })
  return unwrap<RemoteAccessState>(response)
}

export async function stopRemoteAccess(): Promise<RemoteAccessState> {
  const response = await apiFetch("/api/remote-access/stop", {
    method: "POST",
  })
  return unwrap<RemoteAccessState>(response)
}

export async function getRemoteAccessLoginUrl(): Promise<{ loginUrl: string; note: string }> {
  const response = await apiFetch("/api/remote-access/login", {
    method: "POST",
  })
  return unwrap<{ loginUrl: string; note: string }>(response)
}

export async function logoutRemoteAccessLogin(): Promise<RemoteAccessState> {
  const response = await apiFetch("/api/remote-access/logout", {
    method: "POST",
  })
  return unwrap<RemoteAccessState>(response)
}

export async function saveAppConfig(
  patch: { musicRoot?: string }
): Promise<AppConfig> {
  const response = await apiFetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  return unwrap<AppConfig>(response)
}

export async function uploadYoutubeCookies(file: File): Promise<AppConfig> {
  const fd = new FormData()
  fd.append("file", file)
  const response = await apiFetch("/api/config/youtube-cookies", {
    method: "POST",
    body: fd,
  })
  return unwrap<AppConfig>(response)
}

export async function clearYoutubeCookies(): Promise<AppConfig> {
  const response = await apiFetch("/api/config/youtube-cookies", {
    method: "DELETE",
  })
  return unwrap<AppConfig>(response)
}

export async function saveDiscogsToken(token: string): Promise<AppConfig> {
  const response = await apiFetch("/api/config/discogs-token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
  return unwrap<AppConfig>(response)
}

export async function clearDiscogsToken(): Promise<AppConfig> {
  const response = await apiFetch("/api/config/discogs-token", {
    method: "DELETE",
  })
  return unwrap<AppConfig>(response)
}

export type DiscogsReleaseCandidate = {
  releaseId: number
  score: number
  title: string
  year: string | null
  country: string | null
  format: string
  label: string
  catno: string | null
  thumb: string | null
  uri: string | null
  community: { have: number | null; want: number | null }
}

export async function searchDiscogsReleases(
  artist: string,
  album: string,
): Promise<{ ok: true; candidates: DiscogsReleaseCandidate[] }> {
  const response = await apiFetch("/api/discogs/search-releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist, album }),
  })
  return unwrap<{ ok: true; candidates: DiscogsReleaseCandidate[] }>(response)
}

export async function applyDiscogsRelease(
  albumPath: string,
  releaseId: number,
): Promise<{
  ok: true
  albumPath: string
  meta: FetchedAlbumMeta
  album?: LibraryEntityDelta["album"]
  tracks?: LibraryEntityDelta["tracks"]
}> {
  const response = await apiFetch("/api/discogs/apply-release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath, releaseId }),
  })
  return unwrap(response)
}

export async function fetchAccounts(): Promise<AccountsResponse> {
  const response = await apiFetch("/api/accounts", { cache: "no-store" })
  const data = await unwrap<AccountsResponse>(response)
  rememberAvailableAccount(data)
  return data
}

export async function createAccount(input: { name: string }): Promise<AccountsResponse> {
  const response = await apiFetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const data = await unwrap<AccountsResponse>(response)
  if (data.createdAccountId) setSelectedAccountId(data.createdAccountId)
  return data
}

export async function deleteAccount(id: string): Promise<AccountsResponse> {
  const response = await apiFetch(`/api/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  const data = await unwrap<AccountsResponse>(response)
  const selected = getSelectedAccountId()
  if (selected === id) {
    setSelectedAccountId(data.accounts[0]?.id || data.defaultAccountId)
  }
  return data
}

export type ActivityLogEntry = {
  ts: string
  accountId: string
  kind: string
  action: string
  folder: string | null
  musicRoot?: string
  detail?: string | null
}

export async function fetchActivityLog(
  limit = 500,
): Promise<{ entries: ActivityLogEntry[] }> {
  const response = await apiFetch("/api/activity-log", {
    cache: "no-store",
  }, {
    limit: String(limit),
  })
  return unwrap<{ entries: ActivityLogEntry[] }>(response)
}

/** Scarica un ZIP: config, stato utente e metadati (json) per tutti gli account, senza audio. */
export async function downloadKordDataBackup(): Promise<string> {
  const response = await apiFetch("/api/backup/kord-data", {
    method: "GET",
    cache: "no-store",
  })
  if (!response.ok) {
    const text = await response.text()
    let msg = "Backup failed"
    try {
      const j = JSON.parse(text) as { error?: string }
      if (j?.error) msg = j.error
    } catch {
      if (text) msg = text
    }
    throw new Error(msg)
  }
  const cd = response.headers.get("Content-Disposition") || ""
  const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd)
  const name =
    (m?.[1] || "")
      .replace(/^["']|["']$/g, "")
      .trim() || "kord-backup.zip"
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = decodeURIComponent(name)
  a.rel = "noopener"
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return name
}

export async function uploadKordDataRestore(file: File): Promise<{
  restored?: boolean
  accountCount?: number
  themeImported?: boolean
  theme?: string | null
}> {
  const fd = new FormData()
  fd.append("file", file)
  const response = await apiFetch("/api/backup/kord-restore", {
    method: "POST",
    body: fd,
  })
  return unwrap<{
    restored?: boolean
    accountCount?: number
    themeImported?: boolean
    theme?: string | null
  }>(response)
}

/** Scarica lo zip del tema corrente (solo dati del tema, condivisibile). */
export async function downloadThemeExport(): Promise<string> {
  const response = await apiFetch("/api/backup/theme-export", {
    method: "GET",
    cache: "no-store",
  })
  if (!response.ok) {
    const text = await response.text()
    let msg = "Theme export failed"
    try {
      const j = JSON.parse(text) as { error?: string }
      if (j?.error) msg = j.error
    } catch {
      if (text) msg = text
    }
    throw new Error(msg)
  }
  const cd = response.headers.get("Content-Disposition") || ""
  const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd)
  const name =
    (m?.[1] || "")
      .replace(/^["']|["']$/g, "")
      .trim() || "rekord-theme.zip"
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = decodeURIComponent(name)
  a.rel = "noopener"
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return name
}

export type PresetYtdlp = {
  found: boolean
  file: string | null
  text: string
  program: string
  args: string[]
  exampleUrl: string | null
  cookiesConfigured?: boolean
}

export async function fetchDownloadPreset(): Promise<PresetYtdlp> {
  const response = await apiFetch("/api/download-preset")
  return unwrap<PresetYtdlp>(response)
}

export type YoutubeExploreResult = {
  id: string
  type: "song" | "album" | "artist"
  title: string
  subtitle: string
  url: string
  thumbnailUrl?: string | null
}

export async function fetchYoutubeExploreSearch(
  query: string,
): Promise<{ results: YoutubeExploreResult[] }> {
  const response = await apiFetch("/api/youtube-explore-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })
  return unwrap<{ results: YoutubeExploreResult[] }>(response)
}

export type YoutubeReleaseEntry = {
  id: string
  title: string
  url: string
  trackCount: number | null
}

export type YoutubeReleasesList = {
  listTitle: string
  uploader: string
  channelUrl: string
  entries: YoutubeReleaseEntry[]
}

export type YoutubeReleasesListMeta = {
  listTitle: string
  uploader: string
  channelUrl: string
  total: number
}

/**
 * Stesso elenco coi conteggi, ma in streaming (NDJSON): meta → entry × N → done.
 */
export async function streamYoutubeReleasesList(
  url: string,
  cbs: {
    onMeta: (m: YoutubeReleasesListMeta) => void
    onEntry: (e: YoutubeReleaseEntry) => void
    onListReady?: () => void
    onEntryPatch?: (e: YoutubeReleaseEntry) => void
    onDone: () => void
  },
  opts?: { enrichCounts?: boolean; signal?: AbortSignal },
): Promise<void> {
  const signal = opts?.signal
  const response = await apiFetch("/api/youtube-releases-list", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      stream: true,
      ...(opts?.enrichCounts ? { enrichCounts: true } : {}),
    }),
  })
  if (!response.ok) {
    let msg = `Request failed (${response.status})`
    try {
      const j = (await response.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Releases: response body not readable")
  const decoder = new TextDecoder()
  let buffer = ""
  let gotDone = false
  const handleLine = (t: string) => {
    if (!t.trim()) return
    let row: {
      type?: string
      listTitle?: string
      uploader?: string
      channelUrl?: string
      total?: number
      entry?: YoutubeReleaseEntry
      message?: string
    }
    try {
      row = JSON.parse(t) as typeof row
    } catch {
      throw new Error("Releases: invalid response line")
    }
    if (row.type === "meta") {
      cbs.onMeta({
        listTitle: String(row.listTitle ?? "").trim(),
        uploader: String(row.uploader ?? "").trim(),
        channelUrl: String(row.channelUrl ?? "").trim(),
        total: Math.max(0, Math.floor(Number(row.total) || 0)),
      })
      return
    }
    if (row.type === "entry" && row.entry) {
      cbs.onEntry(row.entry)
      return
    }
    if (row.type === "list_ready") {
      cbs.onListReady?.()
      return
    }
    if (row.type === "entry_patch" && row.entry) {
      cbs.onEntryPatch?.(row.entry)
      return
    }
    if (row.type === "done") {
      gotDone = true
      cbs.onDone()
      return
    }
    if (row.type === "error") {
      throw new Error(
        String(row.message ?? "Releases stream error").trim() || "Releases error",
      )
    }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: true })
    }
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const line of parts) {
      handleLine(line)
    }
    if (done) {
      handleLine(buffer)
      break
    }
  }
  if (!gotDone) cbs.onDone()
}

export type DownloadRes = {
  ok: boolean
  stdout: string
  stderr: string
  code: number
  progress?: { current: number; total: number } | null
  musicRoot: string
  command: string
  indexEpoch?: number
  outputDir?: string | null
  error?: string
  cancelled?: boolean
  /** true se yt-dlp ha prodotto output più lungo del contenuto incluso nei campi sopra */
  logTruncated?: boolean
  stdoutTotalChars?: number
  stderrTotalChars?: number
  downloadedItems?: string[]
  skippedItems?: { label: string; reason: string }[]
  failedItems?: { label: string; reason: string }[]
}

function downloadResFromDoneMsg(msg: Record<string, unknown>): DownloadRes {
  return {
    ok: Boolean(msg.ok),
    stdout: String(msg.stdout ?? ""),
    stderr: String(msg.stderr ?? ""),
    code: Number(msg.code ?? -1),
    progress: (msg.progress as DownloadRes["progress"]) ?? null,
    musicRoot: String(msg.musicRoot ?? ""),
    command: String(msg.command ?? ""),
    ...(typeof msg.indexEpoch === "number"
      ? { indexEpoch: Math.floor(Number(msg.indexEpoch)) }
      : {}),
    ...(msg.outputDir != null ? { outputDir: String(msg.outputDir) } : {}),
    ...(msg.cancelled === true ? { cancelled: true } : {}),
    ...(msg.error != null && msg.error !== ""
      ? { error: String(msg.error) }
      : {}),
    ...(msg.logTruncated === true ? { logTruncated: true as const } : {}),
    ...(typeof msg.stdoutTotalChars === "number"
      ? { stdoutTotalChars: Math.floor(Number(msg.stdoutTotalChars)) }
      : {}),
    ...(typeof msg.stderrTotalChars === "number"
      ? { stderrTotalChars: Math.floor(Number(msg.stderrTotalChars)) }
      : {}),
    downloadedItems: Array.isArray(msg.downloadedItems)
      ? msg.downloadedItems.map((x) => String(x)).filter(Boolean)
      : [],
    skippedItems: Array.isArray(msg.skippedItems)
      ? msg.skippedItems
          .map((x) => {
            const row = x as { label?: unknown; reason?: unknown }
            return { label: String(row.label ?? ""), reason: String(row.reason ?? "") }
          })
          .filter((x) => x.label)
      : [],
    failedItems: Array.isArray(msg.failedItems)
      ? msg.failedItems
          .map((x) => {
            const row = x as { label?: unknown; reason?: unknown }
            return { label: String(row.label ?? ""), reason: String(row.reason ?? "") }
          })
          .filter((x) => x.label)
      : [],
  }
}

export type StudioDownloadKind =
  | "download_single"
  | "download_playlist"
  | "download_releases"
  | "download_ytmusic"
  | "download_unknown"

export type RunYtdlpDownloadOpts = {
  signal?: AbortSignal
  /** UUID v4 — obbligatorio per poter fermare il download da /api/download-cancel */
  downloadId: string
  /** Classificazione per il registro attività (Impostazioni) */
  downloadKind?: StudioDownloadKind
}

export async function cancelStudioDownload(downloadId: string): Promise<void> {
  try {
    const response = await apiFetch("/api/download-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ downloadId }),
    })
    if (response.ok) await unwrap(response)
  } catch {
    /* richiesta best-effort */
  }
}

export async function fetchDownloadFlatCount(url: string): Promise<number> {
  const response = await apiFetch("/api/download-flat-count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  const data = await unwrap<{ count: number }>(response)
  const n = data.count
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new Error("Invalid count from server")
  }
  return Math.floor(n)
}

/** UUID v4 per /api/download: su http://IP:porta randomUUID() può lanciare (contesto non sicuro). */
export function newStudioDownloadId(): string {
  return randomUUID()
}

export async function runYtdlpDownload(
  url: string,
  outputDir?: string,
  onProgress?: (p: { current: number; total: number }) => void,
  opts?: RunYtdlpDownloadOpts,
): Promise<DownloadRes> {
  const downloadId = opts?.downloadId?.trim() ?? ""
  if (!downloadId) {
    throw new Error("runYtdlpDownload: downloadId required")
  }
  const response = await apiFetch("/api/download", {
    method: "POST",
    signal: opts?.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      downloadId,
      downloadKind: opts?.downloadKind ?? "download_unknown",
      ...(outputDir != null && outputDir !== "" ? { outputDir } : {}),
    }),
  })
  const ct = response.headers.get("content-type") || ""
  if (!response.ok) {
    let msg = `Download error (${response.status})`
    try {
      const errBody = (await response.json()) as { error?: string }
      if (errBody.error) msg = errBody.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  if (ct.includes("application/json")) {
    return readResponseJson<DownloadRes>(response)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Download: unreadable body")
  const decoder = new TextDecoder()
  let buffer = ""
  let final: DownloadRes | null = null
  let itemSummary: {
    downloadedItems: string[]
    skippedItems: { label: string; reason: string }[]
    failedItems: { label: string; reason: string }[]
  } = {
    downloadedItems: [],
    skippedItems: [],
    failedItems: [],
  }
  const handleLine = (line: string) => {
    const t = line.trim()
    if (!t) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(t) as Record<string, unknown>
    } catch {
      return
    }
    const ty = msg.type
    if (ty === "keepalive" || ty === "started") return
    if (ty === "items") {
      itemSummary = {
        downloadedItems: Array.isArray(msg.downloadedItems)
          ? msg.downloadedItems.map((x) => String(x)).filter(Boolean)
          : [],
        skippedItems: Array.isArray(msg.skippedItems)
          ? msg.skippedItems
              .map((x) => {
                const row = x as { label?: unknown; reason?: unknown }
                return { label: String(row.label ?? ""), reason: String(row.reason ?? "") }
              })
              .filter((x) => x.label)
          : [],
        failedItems: Array.isArray(msg.failedItems)
          ? msg.failedItems
              .map((x) => {
                const row = x as { label?: unknown; reason?: unknown }
                return { label: String(row.label ?? ""), reason: String(row.reason ?? "") }
              })
              .filter((x) => x.label)
          : [],
      }
      return
    }
    if (msg.type === "progress" && onProgress) {
      const pr = msg.progress as { current?: number; total?: number } | undefined
      if (
        pr &&
        typeof pr.current === "number" &&
        typeof pr.total === "number"
      ) {
        onProgress({ current: pr.current, total: pr.total })
      }
    }
    if (msg.type === "done") {
      const pr = msg.progress as { current?: number; total?: number } | undefined
      if (
        onProgress &&
        pr &&
        typeof pr.current === "number" &&
        typeof pr.total === "number"
      ) {
        onProgress({ current: pr.current, total: pr.total })
      }
      final = {
        ...downloadResFromDoneMsg(msg),
        downloadedItems:
          Array.isArray(msg.downloadedItems) && msg.downloadedItems.length
            ? msg.downloadedItems.map((x) => String(x)).filter(Boolean)
            : itemSummary.downloadedItems,
        skippedItems:
          Array.isArray(msg.skippedItems) && msg.skippedItems.length
            ? (downloadResFromDoneMsg(msg).skippedItems ?? [])
            : itemSummary.skippedItems,
        failedItems:
          Array.isArray(msg.failedItems) && msg.failedItems.length
            ? (downloadResFromDoneMsg(msg).failedItems ?? [])
            : itemSummary.failedItems,
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) handleLine(line)
    if (done) {
      buffer += decoder.decode()
      const rest = buffer.split("\n")
      for (const line of rest) handleLine(line)
      break
    }
  }
  if (!final) throw new Error("Download: incomplete response")
  return final
}

export type SanitizeTrackTitlesOneAlbum = {
  changes: { fileName: string; from: string; to: string }[]
  written: boolean
  albumPath: string
}

export type SanitizeTrackTitlesAll = {
  changes: { albumRel: string; fileName: string; from: string; to: string }[]
  albumsScanned: number
  dryRun: boolean
}

export async function sanitizeTrackTitles(
  body: { scope: "all"; dryRun?: boolean },
): Promise<SanitizeTrackTitlesAll>
export async function sanitizeTrackTitles(body: {
  scope: "album"
  albumPath: string
  dryRun?: boolean
}): Promise<SanitizeTrackTitlesOneAlbum>
export async function sanitizeTrackTitles(
  body:
    | { scope: "all"; dryRun?: boolean }
    | { scope: "album"; albumPath: string; dryRun?: boolean },
): Promise<SanitizeTrackTitlesAll | SanitizeTrackTitlesOneAlbum> {
  const response = await apiFetch("/api/studio/sanitize-track-titles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      dryRun: Boolean((body as { dryRun?: boolean }).dryRun),
    }),
  })
  return unwrap<SanitizeTrackTitlesAll | SanitizeTrackTitlesOneAlbum>(response)
}
