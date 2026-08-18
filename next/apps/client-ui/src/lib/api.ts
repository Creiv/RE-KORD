import {
  accountHeaders,
  rememberAvailableAccount,
  withAccountQuery,
  type AccountsResponse,
} from "./account";
import { apiUrl } from "./config";
import { customThemeBgImageUrl } from "./customThemeBgUrl";

export type { Account, AccountsResponse } from "./account";
export { customThemeBgImageUrl };

/** Cached cover variants: pass a CSS size for grids, omit it for hero artwork. */
export type CoverSize = 128 | 256 | "full";

function coverQuery(size?: CoverSize): string {
  return size && size !== "full" ? `?size=${size}` : "";
}

export function albumCoverUrl(albumId: number, size?: CoverSize): string {
  return apiUrl(`/api/v1/covers/album/${albumId}${coverQuery(size)}`);
}

export function artistCoverUrl(artistId: number, size?: CoverSize): string {
  return apiUrl(`/api/v1/covers/artist/${artistId}${coverQuery(size)}`);
}

export type Envelope<T> = { ok: boolean; data?: T; error?: string };

/** Parse JSON body; empty/non-JSON (e.g. Vite proxy 500 when hub is down) → clear Error. */
async function parseJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    const offline =
      res.status === 0 ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      // Vite http-proxy often answers 500 + empty body when the hub is down.
      res.status === 500;
    throw new Error(
      offline
        ? `Hub non raggiungibile (HTTP ${res.status || "—"})`
        : `Risposta vuota dal hub (HTTP ${res.status})`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Risposta non-JSON dal hub (HTTP ${res.status}): ${text.slice(0, 120)}`,
    );
  }
}

async function parseEnvelope<T>(res: Response): Promise<Envelope<T>> {
  return parseJsonBody<Envelope<T>>(res);
}

export type Track = {
  id: number;
  rel_path: string;
  title: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  track_number: number | null;
  album_id: number | null;
  artist_id: number | null;
  genre?: string | null;
  release_date?: string | null;
  lyrics?: string | null;
  source?: string | null;
  url?: string | null;
};

/** Extra Discogs da `discogs_extra_json` / sidecar (camelCase, parity legacy). */
export type DiscogsAlbumExtra = {
  masterId?: number | null;
  discogsUri?: string | null;
  formatSummary?: string | null;
  catalogNo?: string | null;
};

export type Album = {
  id: number;
  name: string;
  artist_name: string;
  track_count: number;
  artist_id: number | null;
  folder_key: string;
  has_cover: boolean;
  loose: boolean;
  /** Sidecar / studio album meta applicata (parity legacy `hasAlbumMeta`). */
  has_album_meta?: boolean;
  genre?: string | null;
  release_date?: string | null;
  label?: string | null;
  country?: string | null;
  /** Tracce attese da catalogo/Discogs (come `expectedTrackCount` React). */
  expected_track_count?: number | null;
  discogs_release_id?: string | null;
  discogs_uri?: string | null;
  discogs_extra?: DiscogsAlbumExtra | null;
};

export type Artist = {
  id: number;
  name: string;
  album_count: number;
  track_count: number;
  has_cover: boolean;
};

export type Playlist = {
  id: string;
  name: string;
  created_at: string;
  track_count: number;
};

export type LibraryStats = {
  track_count: number;
  album_count: number;
  artist_count: number;
  music_root: string | null;
  last_scan_at: string | null;
  /** True while the server is indexing the library. */
  scanning?: boolean;
  /** Filesystem total bytes for the music_root volume. */
  disk_total_bytes?: number | null;
  /** Filesystem available bytes for the music_root volume. */
  disk_available_bytes?: number | null;
};

/** Human-readable byte size (binary GB/MB). */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  const gb = n / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 10) return `${gb.toFixed(1)} GB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Stable keys: artist = name, album = folder_key. */
export type LibrarySelectionV1 = {
  version: 1;
  includeAll: boolean;
  artists: string[];
  albums: string[];
  tracks: string[];
};

export type CatalogAlbumEntry = {
  id: number;
  name: string;
  folder_key: string;
  artist: string;
  artist_id: string;
  track_count: number;
  loose: boolean;
  has_cover: boolean;
};

export type CatalogArtistEntry = {
  /** Stable key (= artist name). */
  id: string;
  name: string;
  album_count: number;
  track_count: number;
  has_cover: boolean;
  db_id?: number | null;
  rel_albums: CatalogAlbumEntry[];
};

export type LibraryCatalogResponse = {
  artists: CatalogArtistEntry[];
};

export type LibrarySelectionPatch = Partial<{
  includeAll: boolean;
  addArtists: string[];
  removeArtists: string[];
  addAlbums: string[];
  removeAlbums: string[];
  addTracks: string[];
  removeTracks: string[];
}>;

/** Voce info/curiosità (kord-artistinfo.json / infoItems album). */
export type EntityInfoItem = {
  id: string;
  lang: string;
  title?: string | null;
  text: string;
  savedAt?: string;
};

export type EntityInfoBundle = {
  items: EntityInfoItem[];
  image?: string | null;
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
};

export type FsDirEntry = { name: string; relPath: string };
export type FsListResponse = {
  path: string;
  parent: string | null;
  dirs: FsDirEntry[];
  musicRoot: string;
};

export type ExploreResult = {
  id: string;
  type: "song" | "album" | "artist" | string;
  title: string;
  subtitle: string;
  url: string;
  thumbnailUrl?: string | null;
};

export type ReleaseEntry = {
  id: string;
  title: string;
  url: string;
  trackCount?: number | null;
};

export type CatalogWebItem = {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  thumbnailUrl?: string | null;
};

export type CatalogWebDiscover = {
  artists: CatalogWebItem[];
  albums: CatalogWebItem[];
  songs: CatalogWebItem[];
  error?: string | null;
};

export type CatalogWebTrack = {
  id: string;
  title: string;
  url: string;
};

export type CatalogWebTracks = {
  tracks: CatalogWebTrack[];
  title?: string | null;
  error?: string | null;
};

export type ArtworkHit = {
  name: string;
  artist: string;
  artwork: string;
  url: string;
  source?: string | null;
};

export type DiscogsCandidate = {
  releaseId: number;
  title: string;
  year?: string | null;
  thumb?: string | null;
  uri?: string | null;
  score: number;
  country?: string | null;
  label?: string | null;
};

export type DownloadNdjsonEvent = {
  type: string;
  progress?: { current: number; total: number };
  ok?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  downloadedItems?: string[];
  skippedItems?: { label: string; reason: string }[];
  failedItems?: { label: string; reason: string }[];
  error?: string;
  message?: string;
  [key: string]: unknown;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = apiUrl(withAccountQuery(path));
  const headers = accountHeaders({
    "Content-Type": "application/json",
    ...(init?.headers || {}),
  });
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
    });
  } catch {
    throw new Error("Hub non raggiungibile (rete)");
  }
  const body = await parseEnvelope<T>(res);
  if (!res.ok || !body.ok) {
    throw new Error(body.error || res.statusText || `HTTP ${res.status}`);
  }
  return body.data as T;
}

/** Request with an explicit account id (does not use the session account). */
async function requestAsAccount<T>(
  accountId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const id = accountId.trim();
  const sep = path.includes("?") ? "&" : "?";
  const url = apiUrl(
    id ? `${path}${sep}accountId=${encodeURIComponent(id)}` : path,
  );
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(id
      ? {
          "X-Rekord-Account-Id": id,
          "X-KORD-Account-Id": id,
        }
      : {}),
    ...(init?.headers || {}),
  };
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    throw new Error("Hub non raggiungibile (rete)");
  }
  const body = await parseEnvelope<T>(res);
  if (!res.ok || !body.ok) {
    throw new Error(body.error || res.statusText || `HTTP ${res.status}`);
  }
  return body.data as T;
}

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

export type LibraryLayoutConfig = {
  schemaVersion: number;
  preferredLayout: "artist/album/track" | "artist/track" | "flat" | "tags";
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

/** Host-level write rights for the current client and account. */
export type MachineAccess = {
  isDefaultAccount: boolean;
  local: boolean;
  allowRemoteAdmin: boolean;
  canManageMachine: boolean;
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

export type TrackPage = {
  items: Track[];
  total: number;
  limit: number;
  offset: number;
};

export type ArtistPage = {
  items: Artist[];
  total: number;
  limit: number;
  offset: number;
};

export type LibraryChanges = {
  revision: string | null;
  full: boolean;
  updated: Track[];
  removed: string[];
  scanning?: boolean;
};

export type UserStatePayload = {
  version: number;
  revision: number;
  playCounts: Record<string, number>;
  recentRelPaths: string[];
  trackMoods: Record<string, string[]>;
  excludedRelPaths: string[];
  excludedAlbumIds: number[];
  settings: Record<string, unknown>;
};

export const api = {
  health: async () => {
    let res: Response;
    try {
      res = await fetch(apiUrl("/api/v1/health"));
    } catch {
      throw new Error("Hub non raggiungibile (rete)");
    }
    return parseJsonBody<{
      ok?: boolean;
      service?: string;
      version?: string;
      modules?: string[];
      scanning?: boolean;
    }>(res);
  },
  stats: () => request<LibraryStats>("/api/v1/library/stats"),
  /** Library rescan. Incremental by default; `full` wipes and rebuilds. */
  scanLibrary: (mode: "incremental" | "full" = "incremental") =>
    request<ScanReport>(`/api/v1/library/scan?mode=${mode}`, { method: "POST" }),
  probeLibrary: () =>
    request<LibraryProbeReport>("/api/v1/library/probe", { method: "POST" }),
  libraryLayout: () => request<LibraryLayoutConfig>("/api/v1/library/layout"),
  setLibraryLayout: (layout: LibraryLayoutConfig) =>
    request<LibraryLayoutConfig>("/api/v1/library/layout", {
      method: "PUT",
      body: JSON.stringify(layout),
    }),
  watchStatus: () => request<WatcherStatus>("/api/v1/library/watch"),
  setWatch: (enabled: boolean) =>
    request<WatcherStatus>("/api/v1/library/watch", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  rebuildThumbnails: () =>
    request<{ started: boolean }>("/api/v1/library/thumbnails", { method: "POST" }),
  jobs: () => request<JobEntry[]>("/api/v1/jobs"),
  cancelJob: (id: string) =>
    request<{ id: string }>(`/api/v1/jobs/${id}/cancel`, { method: "POST" }),
  clearJobs: () => request<{ removed: number }>("/api/v1/jobs", { method: "DELETE" }),
  publicIp: () => request<{ ip: string | null }>("/api/v1/network/public-ip"),
  /** Whether this client may change host-level settings ("machine operations"). */
  machineAccess: () => request<MachineAccess>("/api/v1/system/machine-access"),
  setRemoteAdmin: (enabled: boolean) =>
    request<MachineAccess>("/api/v1/system/machine-access", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  tracks: (limit = 500, offset = 0) =>
    request<Track[]>(`/api/v1/library?limit=${limit}&offset=${offset}`),
  /** Paginated personal library: `{ items, total }`. */
  tracksPage: (limit = 500, offset = 0) =>
    request<TrackPage>(`/api/v1/library/tracks-page?limit=${limit}&offset=${offset}`),
  artistsPage: (limit = 200, offset = 0) =>
    request<ArtistPage>(`/api/v1/library/artists-page?limit=${limit}&offset=${offset}`),
  /** Delta since a revision cursor; `full` asks the client to page again. */
  libraryChanges: (since?: string | null) =>
    request<LibraryChanges>(
      `/api/v1/library/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    ),
  /** Hub caps the limit at 500; the list is windowed, so ask for the full page. */
  search: (q: string, limit = 500) =>
    request<Track[]>(
      `/api/v1/library/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  artists: () => request<Artist[]>("/api/v1/library/artists"),
  artist: (id: number) => request<Artist>(`/api/v1/library/artists/${id}`),
  artistAlbums: (id: number) => request<Album[]>(`/api/v1/library/artists/${id}/albums`),
  albums: () => request<Album[]>("/api/v1/library/albums"),
  album: (id: number) => request<Album>(`/api/v1/library/albums/${id}`),
  albumTracks: (id: number) => request<Track[]>(`/api/v1/library/albums/${id}/tracks`),
  track: (id: number) => request<Track>(`/api/v1/library/tracks/${id}`),
  favorites: () => request<Track[]>("/api/v1/favorites"),
  addFavorite: (track_id: number) =>
    request("/api/v1/favorites", {
      method: "POST",
      body: JSON.stringify({ track_id }),
    }),
  removeFavorite: (track_id: number) =>
    request(`/api/v1/favorites/${track_id}`, { method: "DELETE" }),
  playlists: () => request<Playlist[]>("/api/v1/playlists"),
  createPlaylist: (name: string) =>
    request<Playlist>("/api/v1/playlists", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deletePlaylist: (id: string) =>
    request(`/api/v1/playlists/${id}`, { method: "DELETE" }),
  renamePlaylist: (id: string, name: string) =>
    request<Playlist>(`/api/v1/playlists/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  playlistTracks: (id: string) =>
    request<{ id: string; tracks: Track[] }>(`/api/v1/playlists/${id}`),
  addToPlaylist: (playlistId: string, track_id: number) =>
    request(`/api/v1/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ track_id }),
    }),
  removeFromPlaylist: (playlistId: string, track_id: number) =>
    request(`/api/v1/playlists/${playlistId}/tracks?track_id=${track_id}`, {
      method: "DELETE",
    }),
  /** Rewrites the playlist order; the ids must be the ones already inside it. */
  reorderPlaylist: (playlistId: string, trackIds: number[]) =>
    request(`/api/v1/playlists/${playlistId}/tracks`, {
      method: "PUT",
      body: JSON.stringify({ trackIds }),
    }),
  /** Info/curiosità per artista (album omesso) o album. Nomi cartella. */
  entityInfo: (artist: string, album?: string | null) => {
    const params = new URLSearchParams({ artist });
    if (album) params.set("album", album);
    return request<EntityInfoBundle>(`/api/v1/entity-info?${params}`);
  },

  /** Global FS catalog (not filtered by selection). */
  catalog: (opts?: { summary?: boolean; artistId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.summary) params.set("summary", "1");
    if (opts?.artistId) params.set("artistId", opts.artistId);
    const q = params.toString();
    return request<LibraryCatalogResponse>(
      `/api/v1/catalog${q ? `?${q}` : ""}`,
    );
  },

  myLibrarySelection: () =>
    request<LibrarySelectionV1>("/api/v1/my-library-selection"),

  patchMyLibrarySelection: (patch: LibrarySelectionPatch) =>
    request<LibrarySelectionV1>("/api/v1/my-library-selection", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

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

  /** Export active (or given) account profile ZIP. */
  async exportAccountProfile(accountId: string): Promise<string> {
    const res = await fetch(
      apiUrl(`/api/v1/accounts/${encodeURIComponent(accountId)}/export`),
      { cache: "no-store", headers: accountHeaders() },
    );
    if (!res.ok) {
      let msg = "Esportazione profilo fallita";
      try {
        const j = (await res.json()) as Envelope<unknown>;
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd);
    const name =
      (m?.[1] || "").replace(/^["']|["']$/g, "").trim() || "rekord-profile.zip";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = decodeURIComponent(name);
    a.click();
    URL.revokeObjectURL(url);
    return decodeURIComponent(name);
  },

  /** Ensure a session account id is set from the server registry. */
  async ensureAccountSession(): Promise<AccountsResponse> {
    const data = await request<AccountsResponse>("/api/v1/accounts");
    rememberAvailableAccount(data);
    return data;
  },

  /** Download hub backup ZIP (blob + suggested filename). */
  async downloadBackup(): Promise<string> {
    const res = await fetch(apiUrl("/api/v1/backup/kord-data"), {
      cache: "no-store",
      headers: accountHeaders(),
    });
    if (!res.ok) {
      let msg = "Backup fallito";
      try {
        const j = (await res.json()) as Envelope<unknown>;
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd);
    const name =
      (m?.[1] || "").replace(/^["']|["']$/g, "").trim() || "rekord-backup.zip";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = decodeURIComponent(name);
    a.click();
    URL.revokeObjectURL(url);
    return decodeURIComponent(name);
  },

  /** Download shareable theme ZIP for the current account. */
  async downloadThemeExport(): Promise<string> {
    const res = await fetch(apiUrl("/api/v1/backup/theme-export"), {
      cache: "no-store",
      headers: accountHeaders(),
    });
    if (!res.ok) {
      let msg = "Theme export failed";
      try {
        const j = (await res.json()) as Envelope<unknown>;
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd);
    const name =
      (m?.[1] || "").replace(/^["']|["']$/g, "").trim() || "rekord-theme.zip";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = decodeURIComponent(name);
    a.rel = "noopener";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return decodeURIComponent(name);
  },

  /**
   * Upload backup ZIP (next v3 or legacy v2), or a theme package
   * (`rekord-theme.json`) which applies only theme settings to the current account.
   * Pass `{ themeOnly: true }` to reject non-theme archives (Interface upload).
   */
  restoreBackup: (file: File, opts?: { themeOnly?: boolean }) => {
    const fd = new FormData();
    fd.append("file", file);
    const path = opts?.themeOnly
      ? withAccountQuery("/api/v1/backup/kord-restore?themeOnly=true")
      : withAccountQuery("/api/v1/backup/kord-restore");
    return fetch(apiUrl(path), {
      method: "POST",
      headers: accountHeaders(),
      body: fd,
    }).then(async (res) => {
      const body = await parseEnvelope<{
        restored?: boolean;
        version?: number;
        favorites?: number;
        playlists?: number;
        playlist_tracks?: number;
        library_files?: number;
        scanned_tracks?: number;
        album_meta_merged?: number;
        track_meta_merged?: number;
        themeImported?: boolean;
        theme?: string | null;
        glassSurfaces?: boolean;
        glassOpacity?: number;
      }>(res);
      if (!res.ok || !body.ok) {
        throw new Error(body.error || res.statusText);
      }
      return body.data!;
    });
  },

  config: () => request<HubConfig>("/api/v1/config"),

  uploadYoutubeCookies: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch(apiUrl("/api/v1/config/youtube-cookies"), {
      method: "POST",
      body: fd,
    }).then(async (res) => {
      const body = await parseEnvelope<HubConfig>(res);
      if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
      return body.data!;
    });
  },

  clearYoutubeCookies: () =>
    request<HubConfig>("/api/v1/config/youtube-cookies", { method: "DELETE" }),

  setDiscogsToken: (token: string) =>
    request<HubConfig>("/api/v1/config/discogs-token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  clearDiscogsToken: () =>
    request<HubConfig>("/api/v1/config/discogs-token", { method: "DELETE" }),

  fsList: (path = "") =>
    request<FsListResponse>(
      `/api/v1/fs/list?path=${encodeURIComponent(path)}`,
    ),

  fsSearchDirs: (q: string) =>
    request<{ results: FsDirEntry[]; truncated?: boolean }>(
      `/api/v1/fs/search-dirs?q=${encodeURIComponent(q)}`,
    ),

  fsMkdir: (parent: string, name: string) =>
    request<{ ok: boolean; relPath: string }>("/api/v1/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    }),

  youtubeExploreSearch: (query: string) =>
    request<{ results: ExploreResult[] }>("/api/v1/youtube-explore-search", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),

  youtubeReleasesList: (url: string, enrichCounts = false) =>
    request<{
      listTitle: string;
      uploader: string;
      channelUrl: string;
      entries: ReleaseEntry[];
    }>("/api/v1/youtube-releases-list", {
      method: "POST",
      body: JSON.stringify({ url, enrichCounts, stream: false }),
    }),

  catalogWebDiscover: (force = false) =>
    request<CatalogWebDiscover>(
      `/api/v1/catalog-web-discover${force ? "?force=1" : ""}`,
    ),

  catalogWebTracks: (url: string) =>
    request<CatalogWebTracks>(
      `/api/v1/catalog-web-tracks?url=${encodeURIComponent(url.trim())}`,
    ),

  /** Absolute `<audio src>` for a ~30s audition of a web catalog track. */
  catalogWebPreviewSrc: async (url: string) => {
    const { playUrl } = await request<{ playUrl: string }>(
      `/api/v1/catalog-web-preview?url=${encodeURIComponent(url.trim())}`,
    );
    return apiUrl(playUrl);
  },

  downloadFlatCount: (url: string) =>
    request<{ count: number }>("/api/v1/download-flat-count", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  downloadCancel: (downloadId: string) =>
    request<{ ok: boolean }>("/api/v1/download-cancel", {
      method: "POST",
      body: JSON.stringify({ downloadId }),
    }),

  /** Stream NDJSON download progress. */
  async startDownload(
    body: {
      url: string;
      downloadId: string;
      downloadKind?: string;
      outputDir?: string;
    },
    onEvent: (ev: DownloadNdjsonEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(apiUrl("/api/v1/download"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as Envelope<unknown>;
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("stream non disponibile");
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as DownloadNdjsonEvent);
        } catch {
          /* ignore bad line */
        }
      }
    }
  },

  artworkSearch: (opts: { q?: string; artist?: string; album?: string }) => {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.artist) p.set("artist", opts.artist);
    if (opts.album) p.set("album", opts.album);
    return request<{ results: ArtworkHit[] }>(`/api/v1/artwork/search?${p}`);
  },

  artworkApply: (albumPath: string, imageUrl: string) =>
    request<{ saved: boolean; coverRelPath?: string }>("/api/v1/artwork/apply", {
      method: "POST",
      body: JSON.stringify({ albumPath, imageUrl }),
    }),

  albumInfoFetch: (albumPath: string, artist?: string, album?: string) =>
    fetch(apiUrl("/api/v1/album-info/fetch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ albumPath, artist, album }),
    }).then(async (res) => {
      const body = await parseJsonBody<{
        ok?: boolean;
        error?: string;
        albumPath: string;
        meta: Record<string, unknown>;
      }>(res);
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || res.statusText);
      }
      return body;
    }),

  trackInfoFetchAlbum: (albumPath: string) =>
    request<{
      fetched: number;
      failed: number;
      tracks: unknown[];
      errors: unknown[];
    }>("/api/v1/track-info/fetch-album", {
      method: "POST",
      body: JSON.stringify({ albumPath }),
    }),

  pruneAlbumMetadata: (albumPath: string) =>
    request<{
      albumPath: string;
      removed: string[];
      written: boolean;
      expectedTracksCleared?: boolean;
      trackOrderingFieldsCleared?: number;
      albumFieldsMerged?: number;
      tracksMerged?: number;
      jsonFilesRemoved?: number;
      jsonFilesTrimmed?: number;
    }>("/api/v1/track-info/prune-orphans", {
      method: "POST",
      body: JSON.stringify({ albumPath }),
    }),

  sanitizeTrackTitles: (body: {
    scope: "album" | "all";
    albumPath?: string;
    dryRun: boolean;
  }) =>
    request<{
      changes: Array<{
        albumRel?: string;
        albumPath?: string;
        fileName: string;
        from: string;
        to: string;
      }>;
      albumsScanned?: number;
      dryRun: boolean;
      written?: boolean;
      albumPath?: string;
    }>("/api/v1/studio/sanitize-track-titles", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * Deletes the audio files from disk. `skipped` holds the paths the hub would
   * not touch (already gone, not audio, outside the library).
   */
  deleteTrackFiles: (relPaths: string[]) =>
    request<{ deleted: string[]; skipped: string[]; affectedAlbums: string[] }>(
      "/api/v1/fs/delete-audio-relpaths",
      {
        method: "POST",
        body: JSON.stringify({ relPaths }),
      },
    ),

  /** Deletes the album folder whole: audio, cover and sidecars. */
  deleteAlbumFolder: (albumPath: string) =>
    request<{ deleted: string[]; deletedFolder: string; affectedAlbums: string[] }>(
      "/api/v1/fs/delete-album-folder",
      {
        method: "POST",
        body: JSON.stringify({ albumPath }),
      },
    ),

  downloadPreset: () =>
    request<{
      found: boolean;
      program?: string;
      cookiesConfigured?: boolean;
      text?: string;
      args?: string[];
    }>("/api/v1/download-preset"),

  discogsSearchReleases: (artist: string, album: string) =>
    request<{ ok: boolean; candidates: DiscogsCandidate[] }>(
      "/api/v1/discogs/search-releases",
      {
        method: "POST",
        body: JSON.stringify({ artist, album }),
      },
    ),

  discogsApplyRelease: (albumPath: string, releaseId: number, artist?: string, album?: string) =>
    fetch(apiUrl("/api/v1/discogs/apply-release"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ albumPath, releaseId, artist, album }),
    }).then(async (res) => {
      const body = await parseJsonBody<{ ok?: boolean; error?: string } & Record<string, unknown>>(
        res,
      );
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || res.statusText);
      }
      return body;
    }),

  entityInfoSearch: (artist: string, album?: string | null, lang = "it") =>
    request<{ candidates: Array<{ kind?: string; lang: string; title?: string; text: string }> }>(
      "/api/v1/entity-info/search",
      {
        method: "POST",
        body: JSON.stringify({ artist, album: album || undefined, lang }),
      },
    ),

  entityInfoSave: (body: {
    artist: string;
    album?: string | null;
    add?: Array<{ lang: string; title?: string; text: string }>;
    removeIds?: string[];
    imageUrl?: string | null;
  }) =>
    request<EntityInfoBundle>("/api/v1/entity-info/save", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  trackInfoSave: (
    relPath: string,
    patch: {
      title?: string;
      genre?: string;
      releaseDate?: string;
      lyrics?: string;
    },
  ) =>
    request<{ saved?: boolean }>("/api/v1/track-info/save", {
      method: "POST",
      body: JSON.stringify({ relPath, patch }),
    }),

  trackInfoFetch: (relPath: string) =>
    fetch(apiUrl("/api/v1/track-info/fetch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relPath }),
    }).then(async (res) => {
      const body = await parseJsonBody<{
        ok?: boolean;
        error?: string;
        meta?: Record<string, unknown>;
        lyrics?: string;
      }>(res);
      if (!res.ok || body.ok === false) throw new Error(body.error || res.statusText);
      return body;
    }),

  /** LRCLIB — synced/plain lyrics (parity legacy `/api/track-lyrics/fetch`). */
  trackLyricsFetch: (relPath: string) =>
    request<{
      relPath: string;
      syncedLyrics: string | null;
      plainLyrics: string | null;
    }>("/api/v1/track-lyrics/fetch", {
      method: "POST",
      body: JSON.stringify({ relPath }),
    }),

  albumInfoSave: (
    albumPath: string,
    patch: {
      title?: string;
      genre?: string;
      releaseDate?: string;
      label?: string;
      country?: string;
    },
  ) =>
    request<{ saved?: boolean }>("/api/v1/album-info/save", {
      method: "POST",
      body: JSON.stringify({ albumPath, patch }),
    }),

  artworkUpload: (albumPath: string, file: File) => {
    const fd = new FormData();
    fd.append("albumPath", albumPath);
    fd.append("file", file);
    return fetch(apiUrl("/api/v1/artwork/upload"), {
      method: "POST",
      body: fd,
    }).then(async (res) => {
      const body = await parseEnvelope<{ saved?: boolean; coverRelPath?: string }>(res);
      if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
      return body.data!;
    });
  },

  getUserState: () => request<UserStatePayload>("/api/v1/user-state"),

  getUserStateForAccount: (accountId: string) =>
    requestAsAccount<UserStatePayload>(accountId, "/api/v1/user-state"),

  favoritesForAccount: (accountId: string) =>
    requestAsAccount<Track[]>(accountId, "/api/v1/favorites"),

  playlistsForAccount: (accountId: string) =>
    requestAsAccount<Playlist[]>(accountId, "/api/v1/playlists"),

  patchUserState: (body: Record<string, unknown>) =>
    request<{ revision: number }>("/api/v1/user-state", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  uploadCustomThemeBg: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const url = apiUrl(withAccountQuery("/api/v1/user-state/custom-theme-bg"));
    return fetch(url, {
      method: "POST",
      headers: accountHeaders(),
      body: fd,
    }).then(async (res) => {
      const body = await parseEnvelope<{
        bgImage: string;
        bgImageRev: number;
      }>(res);
      if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
      return body.data!;
    });
  },

  clearCustomThemeBg: async () => {
    const url = apiUrl(withAccountQuery("/api/v1/user-state/custom-theme-bg"));
    const res = await fetch(url, {
      method: "DELETE",
      headers: accountHeaders(),
    });
    const body = await parseEnvelope<null>(res);
    if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
  },

  diagnostics: () =>
    request<{
      version: string;
      uptimeSecs: number;
      musicRoot: string | null;
      scanning: boolean;
      db: {
        trackCount: number;
        albumCount: number;
        artistCount: number;
        lastScanAt: string | null;
      };
      activeDownloads: number;
    }>("/api/v1/diagnostics"),

  activityLog: (opts?: {
    /** Calendar day `YYYY-MM-DD` (Default account only; ignored server-side otherwise). */
    day?: string;
    /** `all` | `system` | `user` */
    scope?: string;
    /** Restrict to one account’s events. */
    filterAccountId?: string;
    limit?: number;
  }) => {
    const p = new URLSearchParams();
    if (opts?.day?.trim()) p.set("day", opts.day.trim());
    if (opts?.scope?.trim()) p.set("scope", opts.scope.trim());
    if (opts?.filterAccountId?.trim()) {
      p.set("filterAccountId", opts.filterAccountId.trim());
    }
    if (opts?.limit != null && Number.isFinite(opts.limit)) {
      p.set("limit", String(Math.trunc(opts.limit)));
    }
    const q = p.toString();
    return request<{
      entries: Array<{
        ts: string;
        kind: string;
        message: string;
        accountId?: string | null;
        accountName?: string | null;
      }>;
      canSelectDay?: boolean;
      scope?: string;
      filterAccountId?: string | null;
      window?: {
        since: string;
        until: string;
        day?: string | null;
      };
    }>(`/api/v1/activity-log${q ? `?${q}` : ""}`);
  },

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
};

export type RemoteAccessStatus = "stopped" | "starting" | "running" | "error";

export type RemoteAccessState = {
  enabled: boolean;
  status: RemoteAccessStatus;
  provider: string;
  publicUrl: string | null;
  error: string | null;
  startedAt: string | null;
  cloudflaredPath: string | null;
  cloudflareLoggedIn: boolean;
  lanUrl: string | null;
  bind: string;
  cloudflaredAvailable: boolean;
};
