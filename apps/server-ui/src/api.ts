import { isGatewayStatus, hubErrorKey } from "./lib/hubErrors";
import { t } from "./lib/i18n.svelte";

/** Default ceiling for a JSON call. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Probes, legacy sync, tunnel start: they shell out or walk the disk. */
export const LONG_TIMEOUT_MS = 120_000;
/** Uploads and downloads of backups. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** A scan answers only when it is done; a big library on a slow disk takes a while. */
export const SCAN_TIMEOUT_MS = 30 * 60_000;

export type Envelope<T> = { ok: boolean; data?: T; error?: string };

export type ApiErrorKind =
  /** fetch() rejected: hub stopped, network down, connection dropped. */
  | "network"
  /** Our own timer gave up. */
  | "timeout"
  /** The hub answered with a non-2xx status or `ok: false`. */
  | "http"
  /** 2xx with a body we could not read. */
  | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when no response arrived. */
  readonly status: number;
  /** `error` field of the hub envelope, when there was one. */
  readonly code: string | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number; code?: string | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.code = opts.code ?? null;
  }
}

export function isApiError(e: unknown, kind?: ApiErrorKind): e is ApiError {
  return e instanceof ApiError && (kind == null || e.kind === kind);
}

/** Text for any thrown value, already localised for ApiError. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RequestOptions = RequestInit & {
  /** Milliseconds before giving up. */
  timeoutMs?: number;
};

function httpError(res: Response, body: unknown, fallback?: string): ApiError {
  const env = (body && typeof body === "object" ? body : null) as { error?: unknown } | null;
  const code = env && typeof env.error === "string" && env.error ? env.error : null;
  const mapped = hubErrorKey(res.status, code, env != null);
  const message = mapped
    ? t(mapped.key, mapped.vars)
    : code || fallback || t("errors.http", { status: res.status });
  return new ApiError("http", message, { status: res.status, code });
}

/**
 * `fetch` with a timer. Body reading happens inside `read`, so the timer also
 * covers a hub that sends headers and then stalls.
 */
async function fetchHub<R>(
  path: string,
  opts: RequestOptions,
  read: (res: Response) => Promise<R>,
): Promise<R> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = opts;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const fail = (e: unknown): never => {
    if (e instanceof ApiError) throw e;
    if (timedOut) {
      throw new ApiError("timeout", t("errors.timeout", { seconds: Math.round(timeoutMs / 1000) }));
    }
    throw new ApiError("network", t("errors.network"));
  };
  try {
    let res: Response;
    try {
      res = await fetch(path, { ...init, signal: controller.signal });
    } catch (e) {
      return fail(e);
    }
    try {
      return await read(res);
    } catch (e) {
      return fail(e);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON body; empty or HTML bodies (proxy pages) become an ApiError. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unwrap<T>(res: Response, body: Record<string, unknown> | null): T {
  if (!res.ok || body?.ok === false) throw httpError(res, body);
  if (body == null) {
    if (isGatewayStatus(res.status)) throw httpError(res, null);
    throw new ApiError("parse", t("errors.badResponse", { status: res.status }), {
      status: res.status,
    });
  }
  if ("data" in body && body.data !== undefined) return body.data as T;
  return body as unknown as T;
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  return fetchHub(path, { ...init, headers }, async (res) => unwrap<T>(res, await readJson(res)));
}

/** Multipart upload (no JSON content type). */
async function upload<T>(path: string, form: FormData): Promise<T> {
  return fetchHub(
    path,
    { method: "POST", body: form, timeoutMs: UPLOAD_TIMEOUT_MS },
    async (res) => unwrap<T>(res, await readJson(res)),
  );
}

/**
 * Binary download (backups, exports). HTTP errors still read the JSON
 * envelope, so a 403 says why instead of opening a tab full of JSON.
 */
async function download(path: string, fallbackName: string): Promise<void> {
  const { blob, name } = await fetchHub(
    path,
    { cache: "no-store", timeoutMs: UPLOAD_TIMEOUT_MS },
    async (res) => {
      if (!res.ok) throw httpError(res, await readJson(res));
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd);
      const raw = (m?.[1] || "").replace(/^["']|["']$/g, "").trim() || fallbackName;
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        /* already plain */
      }
      return { blob: await res.blob(), name: decoded };
    },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Kind of a podcast source as the hub detected it. */
export type PodcastKind = "rss" | "rtl" | "ytdlp" | "live";

export type PodcastEpisodePreview = {
  key: string;
  title: string;
  publishedAt?: string | null;
  durationSecs?: number | null;
};

/** `POST /podcasts/admin/test`: what the URL is, nothing saved. */
export type PodcastPreview = {
  kind: PodcastKind;
  live: boolean;
  title: string | null;
  hasArt: boolean;
  episodes: PodcastEpisodePreview[];
};

export type PodcastSourceAdmin = {
  id: number;
  url: string;
  name: string;
  nameCustom: boolean;
  kind: PodcastKind;
  live: boolean;
  episodeCount: number;
  position: number;
  hasArt: boolean;
  fetchedAt: string | null;
  error: string | null;
  errorAt: string | null;
  episodes: PodcastEpisodePreview[];
};

export type PodcastsAdmin = {
  enabled: boolean;
  cacheTtlMinutes: number;
  ytdlpEnabled: boolean;
  limits: {
    maxSources: number;
    maxEpisodes: number;
    defaultEpisodes: number;
    minTtlMinutes: number;
    maxTtlMinutes: number;
  };
  sources: PodcastSourceAdmin[];
};

export type Health = {
  service?: string;
  version?: string;
  scanning?: boolean;
};

export type LibraryStats = {
  track_count: number;
  album_count: number;
  artist_count: number;
  music_root: string | null;
  last_scan_at: string | null;
  scanning?: boolean;
  disk_total_bytes?: number | null;
  disk_available_bytes?: number | null;
};

export type ScanMode = "incremental" | "full";

export type ScanReport = {
  scannedFiles: number;
  indexedTracks: number;
  unchanged: number;
  skipped: number;
  errors: number;
  removedTracks: number;
  removedAlbums: number;
  removedArtists: number;
  mode: string;
  music_root: string;
  /** Indexed tracks whose file was not found this time. */
  missingTracks?: number;
  /** Why the removal of missing tracks was skipped (absent when nothing was skipped). */
  pruneSkipped?: string | null;
  /** Folders (relative to the music root) that could not be listed; their tracks were kept. */
  unreadableDirs?: string[];
};

/** Per-category counts of a legacy import (hub `LegacyImportCounts`). */
export type LegacyImportCounts = {
  favorites: number;
  /** Of `favorites`, those whose file is not indexed yet. */
  favoritesParked: number;
  playlists: number;
  playlistTracks: number;
  playlistTracksParked: number;
  moods: number;
  excludedTracks: number;
  excludedAlbums: number;
  playCounts: number;
  recent: number;
  settings: number;
  plectrBests: number;
  selections: number;
  themeBackgrounds: number;
};

export type LegacyAccountStatus = "imported" | "unchanged" | "skipped";

/** One legacy account (`.kord/<id>_info`) in a report. */
export type LegacyAccountReport = {
  legacyId: string;
  legacyName?: string;
  hubId: string;
  hubName?: string;
  status: LegacyAccountStatus;
  /** `not_registered`, `no_data`, `already_imported`, `read_error`. */
  reason?: string;
  created: boolean;
  counts: LegacyImportCounts;
  unmatchedPaths: string[];
  unmatchedCount: number;
  unmatchedAlbumKeys: string[];
};

/** `POST /legacy-import` (hub `LegacyImportReport`). */
export type LegacyImportReport = {
  trigger: "auto" | "manual" | "cli";
  dryRun: boolean;
  ranAt: string;
  musicRoot: string;
  kordFound: boolean;
  albumMetaMerged: number;
  trackMetaMerged: number;
  metadataError?: string;
  accountsAdded: number;
  totals: LegacyImportCounts;
  unmatchedCount: number;
  accounts: LegacyAccountReport[];
};

/** `GET /legacy-import`. */
export type LegacyImportStatus = {
  musicRoot: string | null;
  kordFound: boolean;
  pending: boolean;
  optedOut: boolean;
  importedAt?: string;
  lastReport?: LegacyImportReport;
};

export type PreferredLayout = "artist/album/track" | "artist/track" | "flat" | "tags";

export type LibraryLayoutConfig = {
  schemaVersion: number;
  preferredLayout: PreferredLayout;
  fallbacks: string[];
  virtualArtist: string;
  virtualAlbum: string;
  deepScan: boolean;
};

export type LibraryProbeReport = {
  stats: {
    audioAtRoot: number;
    dirsAtRoot: number;
    dirsWithOnlyAudio: number;
    dirsWithSubdirs: number;
    maxDepth: number;
    estimatedTracks: number;
  };
  candidates: { layout: string; confidence: number; reason: string }[];
  warnings: string[];
  suggestedLayout: LibraryLayoutConfig;
  currentLayout: LibraryLayoutConfig;
};

export type EmbeddedPriority = "studio" | "embedded";

/** `GET /api/v1/library/embedded`: embedded tags / covers and the backfill. */
export type EmbeddedStatus = {
  enabled: boolean;
  priority: EmbeddedPriority;
  pendingTracks: number;
  pendingAlbums: number;
  running: boolean;
  overrideStudio: boolean;
};

export type WatcherStatus = {
  enabled: boolean;
  running: boolean;
  root: string | null;
  events: number;
  lastEventAt: string | null;
  lastScanAt: string | null;
  pending: boolean;
  error: string | null;
};

export type JobEntry = {
  id: string;
  kind: string;
  label: string;
  status: "running" | "done" | "failed" | "canceled";
  progress: number | null;
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  cancelable: boolean;
  /** Stable codes for `label` / `message` / `error` (translated with `params`). */
  titleCode?: string | null;
  detailCode?: string | null;
  errorCode?: string | null;
  params?: Record<string, unknown> | null;
};

export type BinaryStatus = {
  available: boolean;
  path?: string | null;
  version?: string | null;
};

export type ErrorEntry = {
  ts: string;
  level: string;
  target: string;
  message: string;
};

export type Diagnostics = {
  version: string;
  uptimeSecs: number;
  musicRoot: string | null;
  dataDir: string;
  scanning: boolean;
  db: {
    trackCount: number;
    albumCount: number;
    artistCount: number;
    lastScanAt: string | null;
    sizeBytes: number | null;
  };
  activeDownloads: number;
  jobs: { active: number; recent: JobEntry[] };
  watcher: WatcherStatus;
  binaries: {
    ytdlp: BinaryStatus;
    ffmpeg: BinaryStatus;
    ffprobe: BinaryStatus;
    cloudflared: { available: boolean };
  };
  layout: LibraryLayoutConfig | null;
  disk: { totalBytes: number; availableBytes: number } | null;
  errors: { count: number; recent: ErrorEntry[] };
  allowRemoteAdmin: boolean;
  /**
   * Last scan guard outcome and the favorites / playlist entries parked until
   * their file comes back.
   */
  library?: {
    lastPruneSkipped?: string | null;
    parkedFavorites?: number;
    parkedPlaylistTracks?: number;
  };
};

export type ActivityEntry = {
  ts: string;
  kind: string;
  message: string;
  /** `"{kind}.{action}"` plus placeholders, when the hub wrote a coded line. */
  action?: string | null;
  code?: string | null;
  params?: Record<string, unknown> | null;
  accountId?: string | null;
  accountName?: string | null;
};

export type ActivityLog = {
  entries: ActivityEntry[];
  canSelectDay?: boolean;
  scope?: string;
  filterAccountId?: string | null;
  window?: { since: string; until: string; day?: string | null };
};

export type Account = { id: string; name: string };
export type AccountsResponse = {
  defaultAccountId: string;
  accounts: Account[];
  createdAccountId?: string;
};

export type MachineAccess = {
  isDefaultAccount: boolean;
  local: boolean;
  allowRemoteAdmin: boolean;
  canManageMachine: boolean;
};

export type HubConfig = {
  musicRoot?: string | null;
  dataDir?: string;
  ytdlpEnabled?: boolean;
  youtubeCookiesConfigured?: boolean;
  youtubeCookiesLockedByEnv?: boolean;
  youtubeCookiesLabel?: string;
  youtubeCookiesWritable?: boolean;
  /** A file is stored (valid or not); hub ≥ 5.2. */
  youtubeCookiesPresent?: boolean;
  youtubeCookiesValid?: boolean;
  youtubeCookiesEntries?: number;
  /** Entries for youtube.com / google.com. */
  youtubeCookiesYoutubeEntries?: number;
  /** RFC 3339 modification time of the stored file. */
  youtubeCookiesUpdatedAt?: string | null;
  discogsConfigured?: boolean;
  discogsTokenConfigured?: boolean;
  discogsLockedByEnv?: boolean;
  discogsWritable?: boolean;
  machineAccess?: MachineAccess;
};

export type RemoteAccessState = {
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "error";
  provider: string;
  publicUrl: string | null;
  error: string | null;
  /** Stable code for `error`, translated by the panel. */
  errorCode?: string | null;
  startedAt: string | null;
  cloudflaredPath: string | null;
  cloudflareLoggedIn: boolean;
  lanUrl: string | null;
  /** Every LAN address of the hub, best first (`lanUrl` is the first one). */
  lanUrls?: string[];
  bind: string;
  cloudflaredAvailable: boolean;
  machineAccess?: MachineAccess;
};

export type PreventSleepMode = "off" | "always" | "whenActive";

/** `GET /api/v1/system/power`: sleep prevention setting and live status. */
export type PowerState = {
  preventSleep: PreventSleepMode;
  graceMinutes: number;
  keepAwakeLidClosed: boolean;
  /** `REKORD_PREVENT_SLEEP` / `--prevent-sleep` sets the mode. */
  lockedByEnv: boolean;
  platform: string;
  limits: { minGraceMinutes: number; maxGraceMinutes: number; defaultGraceMinutes: number };
  status: {
    inhibiting: boolean;
    reason: "always" | "active" | null;
    since: string | null;
    lastActivity: string | null;
    lastActivityKind: "stream" | "job" | "remote" | null;
    activeStreams: number;
    activeJobs: number;
    releaseAt: string | null;
    method: string | null;
    supported: boolean;
    lidSupported: boolean;
    lidInhibited: boolean;
    errorCode: string | null;
    error: string | null;
    lidErrorCode: string | null;
    lidError: string | null;
  };
  machineAccess?: MachineAccess;
};

export type PowerPatch = {
  preventSleep?: PreventSleepMode;
  graceMinutes?: number;
  keepAwakeLidClosed?: boolean;
};

export type RestoreReport = {
  version?: number;
  favorites?: number;
  playlists?: number;
  playlist_tracks?: number;
  library_files?: number;
  scanned_tracks?: number;
  album_meta_merged?: number;
  track_meta_merged?: number;
  themeOnly?: boolean;
};

export const api = {
  health: () => request<Health>("/api/v1/health"),
  stats: () => request<LibraryStats>("/api/v1/library/stats"),

  getPath: () => request<{ music_root: string | null }>("/api/v1/library/path"),
  setPath: (music_root: string) =>
    request<{ music_root: string }>("/api/v1/library/path", {
      method: "PUT",
      body: JSON.stringify({ music_root }),
    }),

  scan: (mode: ScanMode = "incremental") =>
    request<ScanReport>(`/api/v1/library/scan?mode=${mode}`, {
      method: "POST",
      timeoutMs: SCAN_TIMEOUT_MS,
    }),

  probe: () =>
    request<LibraryProbeReport>("/api/v1/library/probe", {
      method: "POST",
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  getLayout: () => request<LibraryLayoutConfig>("/api/v1/library/layout"),
  setLayout: (layout: Partial<LibraryLayoutConfig>) =>
    request<LibraryLayoutConfig>("/api/v1/library/layout", {
      method: "PUT",
      body: JSON.stringify(layout),
    }),

  watch: () => request<WatcherStatus>("/api/v1/library/watch"),
  setWatch: (enabled: boolean) =>
    request<WatcherStatus>("/api/v1/library/watch", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  rebuildThumbnails: () =>
    request<{ started: boolean }>("/api/v1/library/thumbnails", { method: "POST" }),

  embedded: () => request<EmbeddedStatus>("/api/v1/library/embedded"),
  setEmbedded: (next: { enabled?: boolean; priority?: EmbeddedPriority }) =>
    request<EmbeddedStatus>("/api/v1/library/embedded", {
      method: "PUT",
      body: JSON.stringify(next),
    }),
  rereadEmbedded: (overrideStudio = false) =>
    request<EmbeddedStatus>("/api/v1/library/embedded/reread", {
      method: "POST",
      body: JSON.stringify({ overrideStudio }),
    }),

  legacyImportStatus: () => request<LegacyImportStatus>("/api/v1/legacy-import"),
  legacyImport: (opts: { dryRun?: boolean; force?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.dryRun) q.set("dryRun", "true");
    if (opts.force) q.set("force", "true");
    const qs = q.toString();
    return request<LegacyImportReport>(`/api/v1/legacy-import${qs ? `?${qs}` : ""}`, {
      method: "POST",
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  jobs: () => request<JobEntry[]>("/api/v1/jobs"),
  cancelJob: (id: string) =>
    request<{ id: string }>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  clearJobs: () => request<{ removed: number }>("/api/v1/jobs", { method: "DELETE" }),

  diagnostics: () => request<Diagnostics>("/api/v1/diagnostics"),
  clearErrors: () =>
    request<{ cleared: boolean }>("/api/v1/diagnostics/errors", { method: "DELETE" }),

  activityLog: (opts?: { day?: string; scope?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.day?.trim()) p.set("day", opts.day.trim());
    if (opts?.scope?.trim()) p.set("scope", opts.scope.trim());
    if (opts?.limit != null) p.set("limit", String(Math.trunc(opts.limit)));
    const q = p.toString();
    return request<ActivityLog>(`/api/v1/activity-log${q ? `?${q}` : ""}`);
  },

  accounts: () => request<AccountsResponse>("/api/v1/accounts"),
  createAccount: (name: string) =>
    request<AccountsResponse>("/api/v1/accounts", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameAccount: (id: string, name: string) =>
    request<AccountsResponse>(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  deleteAccount: (id: string) =>
    request<AccountsResponse>(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  exportAccount: (id: string) =>
    download(`/api/v1/accounts/${encodeURIComponent(id)}/export`, `rekord-account-${id}.zip`),

  downloadBackup: () => download("/api/v1/backup/kord-data", "rekord-backup.zip"),
  restore: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return upload<RestoreReport>("/api/v1/backup/kord-restore", form);
  },

  config: () => request<HubConfig>("/api/v1/config"),
  uploadCookies: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return upload<HubConfig>("/api/v1/config/youtube-cookies", form);
  },
  clearCookies: () =>
    request<HubConfig>("/api/v1/config/youtube-cookies", { method: "DELETE" }),
  setDiscogsToken: (token: string) =>
    request<HubConfig>("/api/v1/config/discogs-token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),
  clearDiscogsToken: () =>
    request<HubConfig>("/api/v1/config/discogs-token", { method: "DELETE" }),

  remoteAccess: () => request<RemoteAccessState>("/api/v1/remote-access"),
  remoteStart: () =>
    request<RemoteAccessState>("/api/v1/remote-access/start", {
      method: "POST",
      body: "{}",
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  remoteStop: () =>
    request<RemoteAccessState>("/api/v1/remote-access/stop", {
      method: "POST",
      body: "{}",
    }),
  remoteLogin: () =>
    request<{ loginUrl: string; note: string; cloudflareLoggedIn: boolean }>(
      "/api/v1/remote-access/login",
      { method: "POST", body: "{}", timeoutMs: LONG_TIMEOUT_MS },
    ),
  remoteLogout: () =>
    request<RemoteAccessState>("/api/v1/remote-access/logout", {
      method: "POST",
      body: "{}",
    }),

  publicIp: () => request<{ ip: string | null }>("/api/v1/network/public-ip"),

  podcasts: () => request<PodcastsAdmin>("/api/v1/podcasts/admin"),
  setPodcastSettings: (patch: { enabled?: boolean; cacheTtlMinutes?: number }) =>
    request<PodcastsAdmin>("/api/v1/podcasts/admin/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  testPodcastSource: (url: string, episodeCount: number) =>
    request<PodcastPreview>("/api/v1/podcasts/admin/test", {
      method: "POST",
      body: JSON.stringify({ url, episodeCount }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  addPodcastSource: (body: { url: string; name?: string; episodeCount: number }) =>
    request<PodcastSourceAdmin>("/api/v1/podcasts/admin/sources", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  updatePodcastSource: (id: number, patch: { name?: string; episodeCount?: number; url?: string }) =>
    request<PodcastSourceAdmin>(`/api/v1/podcasts/admin/sources/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  deletePodcastSource: (id: number) =>
    request<{ deleted: number }>(`/api/v1/podcasts/admin/sources/${id}`, { method: "DELETE" }),
  orderPodcastSources: (ids: number[]) =>
    request<PodcastsAdmin>("/api/v1/podcasts/admin/order", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),

  power: () => request<PowerState>("/api/v1/system/power"),
  setPower: (patch: PowerPatch) =>
    request<PowerState>("/api/v1/system/power", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  machineAccess: () => request<MachineAccess>("/api/v1/system/machine-access"),
  setRemoteAdmin: (enabled: boolean) =>
    request<MachineAccess>("/api/v1/system/machine-access", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
};
