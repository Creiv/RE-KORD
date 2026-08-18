export type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      ...init,
    });
  } catch {
    throw new Error("Hub non raggiungibile");
  }
  const body = (await res.json().catch(() => ({}))) as Envelope<T> &
    Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText || `HTTP ${res.status}`);
  }
  if ("data" in body && body.data !== undefined) return body.data as T;
  return body as unknown as T;
}

/** Multipart upload (no JSON content type). */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText || `HTTP ${res.status}`);
  }
  return body.data as T;
}

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
};

export type ActivityEntry = {
  ts: string;
  kind: string;
  message: string;
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
  startedAt: string | null;
  cloudflaredPath: string | null;
  cloudflareLoggedIn: boolean;
  lanUrl: string | null;
  bind: string;
  cloudflaredAvailable: boolean;
  machineAccess?: MachineAccess;
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
    request<ScanReport>(`/api/v1/library/scan?mode=${mode}`, { method: "POST" }),

  probe: () =>
    request<LibraryProbeReport>("/api/v1/library/probe", { method: "POST" }),
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

  syncLegacyMeta: () =>
    request<Record<string, number>>("/api/v1/library/sync-legacy-meta", {
      method: "POST",
    }),

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
  accountExportUrl: (id: string) =>
    `/api/v1/accounts/${encodeURIComponent(id)}/export`,

  backupUrl: () => "/api/v1/backup/kord-data",
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
    }),
  remoteStop: () =>
    request<RemoteAccessState>("/api/v1/remote-access/stop", {
      method: "POST",
      body: "{}",
    }),
  remoteLogin: () =>
    request<{ loginUrl: string; note: string; cloudflareLoggedIn: boolean }>(
      "/api/v1/remote-access/login",
      { method: "POST", body: "{}" },
    ),
  remoteLogout: () =>
    request<RemoteAccessState>("/api/v1/remote-access/logout", {
      method: "POST",
      body: "{}",
    }),

  publicIp: () => request<{ ip: string | null }>("/api/v1/network/public-ip"),

  machineAccess: () => request<MachineAccess>("/api/v1/system/machine-access"),
  setRemoteAdmin: (enabled: boolean) =>
    request<MachineAccess>("/api/v1/system/machine-access", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
};
