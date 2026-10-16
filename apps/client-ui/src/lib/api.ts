import { rememberAvailableAccount, type AccountsResponse } from "./account";
import {
  ApiError,
  LONG_TIMEOUT_MS,
  translateHubError,
  UPLOAD_TIMEOUT_MS,
  fetchHub,
  parseJsonBody,
  request,
  requestBlob,
  requestJson,
  saveBlob,
  type Envelope,
  type RequestOptions,
} from "./api/http";
import { apiUrl } from "./config";
import { externalArtPath, isExternalPath, type ExternalMeta } from "./externalItems";
import { customThemeBgImageUrl } from "./customThemeBgUrl";
import { t } from "./i18n.svelte";

export type { Account, AccountsResponse } from "./account";
export { customThemeBgImageUrl };
export {
  ApiError,
  DEFAULT_TIMEOUT_MS,
  LONG_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  describeHubError,
  forbiddenMessage,
  isAbortError,
  isOfflineError,
  onAccountRejected,
  onHubReachability,
  translateHubError,
  type ApiErrorKind,
  type Envelope,
  type RequestOptions,
} from "./api/http";

/** Per-call knobs every API method accepts as its last argument. */
export type CallOptions = Pick<RequestOptions, "signal" | "timeoutMs">;

/**
 * Cached cover variants: pass a CSS size for grids, omit it for hero artwork.
 * Any pixel size is accepted; the hub snaps it to its nearest cached bucket.
 */
export type CoverSize = 128 | 256 | "full" | (number & {});

function coverQuery(size?: CoverSize): string {
  if (!size || size === "full") return "";
  const px = Math.round(Number(size));
  return px > 0 ? `?size=${px}` : "";
}

export function albumCoverUrl(albumId: number, size?: CoverSize): string {
  return apiUrl(`/api/v1/covers/album/${albumId}${coverQuery(size)}`);
}

export function artistCoverUrl(artistId: number, size?: CoverSize): string {
  return apiUrl(`/api/v1/covers/artist/${artistId}${coverQuery(size)}`);
}

function withVersion(url: string, version: unknown): string {
  if (version == null || version === "" || version === 0) return url;
  const v = encodeURIComponent(String(version));
  return `${url}${url.includes("?") ? "&" : "?"}v=${v}`;
}

/** What the hub says about one album's artwork (from the album list). */
type AlbumCoverInfo = { has: boolean; version: unknown };
const albumCoverInfo = new Map<number, AlbumCoverInfo>();

/**
 * Learn which albums have artwork from an album list, so track covers can be
 * skipped for albums known to have none (no 404 per row) even when the hub
 * does not send `has_cover` per track. The session calls it on every album
 * list it loads.
 */
export function noteAlbumCovers(albums: readonly Pick<Album, "id" | "has_cover" | "cover_version">[]) {
  for (const a of albums) {
    if (typeof a?.id !== "number") continue;
    albumCoverInfo.set(a.id, { has: a.has_cover !== false, version: a.cover_version ?? null });
  }
}

/** Anything that may have a cover: a track, an album or an artist. */
export type CoverEntity =
  | Pick<Track, "album_id" | "rel_path" | "has_cover" | "cover_version" | "album_has_cover" | "external">
  | Pick<Album, "id" | "folder_key" | "has_cover" | "cover_version">
  | Pick<Artist, "id" | "has_cover" | "album_count">;

/**
 * Cover URL for a track (its album's artwork), an album or an artist, or
 * `null` when the hub says there is none (`has_cover === false`) — callers
 * then show their placeholder instead of requesting a known 404. Adds
 * `?v=<cover_version>` when the hub sends one, so a changed cover is
 * refetched while an unchanged one stays cached.
 */
export function coverUrlFor(
  entity: CoverEntity | null | undefined,
  size?: CoverSize,
): string | null {
  if (!entity) return null;
  if ("rel_path" in entity) {
    if (isExternalPath(entity.rel_path)) {
      // Podcast episode / live stream: the hub's artwork thumbnail, if any.
      const art = externalArtPath(entity as { rel_path: string; external?: ExternalMeta });
      return art ? apiUrl(art) : null;
    }
    const albumId = entity.album_id;
    if (albumId == null) return null;
    const known = albumCoverInfo.get(albumId);
    const has = entity.has_cover ?? entity.album_has_cover ?? known?.has;
    if (has === false) return null;
    return withVersion(albumCoverUrl(albumId, size), entity.cover_version ?? known?.version);
  }
  if ("folder_key" in entity) {
    if (entity.has_cover === false) return null;
    return withVersion(
      albumCoverUrl(entity.id, size),
      entity.cover_version ?? albumCoverInfo.get(entity.id)?.version,
    );
  }
  if (entity.has_cover === false) return null;
  return artistCoverUrl(entity.id, size);
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
  /** Parsed genres, when the hub sends them (preferred over splitting `genre`). */
  genres?: string[] | null;
  release_date?: string | null;
  lyrics?: string | null;
  source?: string | null;
  url?: string | null;
  /** Whether the track's album has artwork (hub ≥ 5.2); see `coverUrlFor`. */
  has_cover?: boolean;
  /** Alias some hub builds use for `has_cover` on tracks. */
  album_has_cover?: boolean;
  /** Changes when the album artwork changes (cache-busting `?v=`). */
  cover_version?: string | number | null;
  /** File name on disk (`title` is the cleaned display title). */
  file_name?: string | null;
  disc_number?: number | null;
  added_at?: string | null;
  updated_at?: string | null;
  /** A person edited these values: fetches / imports do not replace them. */
  user_edited?: boolean;
  curated_fields?: string[] | null;
  /** Podcast episode / live stream played through the hub (see `externalItems`). */
  external?: ExternalMeta;
};

/** Discogs extras from `discogs_extra_json` / sidecar (camelCase, legacy parity). */
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
  /** Changes when the artwork changes (cache-busting `?v=`). */
  cover_version?: string | number | null;
  /** Folder name on disk (`name` is the display title; write with `folder_key`). */
  folder_name?: string | null;
  /** Canonical genre labels. */
  genres?: string[] | null;
  added_at?: string | null;
  /** Title / dates / genre / cover / track list changed: "recently updated" order. */
  updated_at?: string | null;
  user_edited?: boolean;
  curated_fields?: string[] | null;
  loose: boolean;
  /** Sidecar / studio album meta applied (legacy parity `hasAlbumMeta`). */
  has_album_meta?: boolean;
  genre?: string | null;
  release_date?: string | null;
  label?: string | null;
  country?: string | null;
  /** Tracks expected from the catalog/Discogs (like React `expectedTrackCount`). */
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
  /** Bumped by every scan / folder rescan (hub ≥ 5.2). */
  index_epoch?: number;
  albums_without_cover?: number;
  albums_without_meta?: number;
  tracks_without_meta?: number;
  loose_album_count?: number;
  genre_count?: number;
  /** Tracks in the whole catalog (the other counts are the account's selection). */
  catalog_track_count?: number;
};

/** One canonical genre of the account's library (`GET /library/genres`). */
export type LibraryGenre = {
  /** Same as `normalizeGenreKey` (lib/genres). */
  key: string;
  label: string;
  track_count: number;
  album_count: number;
  artist_count: number;
};

/** `GET /library/search?scope=all`. */
export type LibrarySearchAll = {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
};

/** yt-dlp as the hub sees it (`diagnostics.binaries.ytdlp`). */
export type YtdlpInfo = {
  version: string | null;
  releaseDate?: string | null;
  ageDays?: number | null;
  stale?: boolean;
  source?: string | null;
};

/** `POST /tools/ytdlp/update`. */
export type YtdlpUpdateResult = {
  updated: boolean;
  upToDate: boolean;
  latestVersion?: string | null;
  previousVersion?: string | null;
  version?: string | null;
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

/** Info/curiosità entry (kord-artistinfo.json / album infoItems). */
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

/** Request with an explicit account id (does not use the session account). */
function requestAsAccount<T>(
  accountId: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  return request<T>(path, { ...opts, accountId });
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
  /**
   * Library operations (Studio writes, file deletes, account create / rename /
   * delete): any account on the hub machine; remote clients need remote admin.
   * Absent on older hubs (then derived from `canManageMachine`).
   */
  canManageLibrary?: boolean;
  /** Machine operations (scans, library path, integrations, backups, tunnel): Default account + local. */
  canManageMachine: boolean;
  /** Error code saying why library operations are refused (`forbidden_remote`), or null. */
  libraryDeniedReason?: string | null;
  /** Error code saying why machine operations are refused, or null. */
  machineDeniedReason?: string | null;
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

/** Body of `PATCH /api/v1/user-state`; omitted fields stay as they are. */
export type UserStatePatch = Partial<
  Pick<
    UserStatePayload,
    | "playCounts"
    | "recentRelPaths"
    | "trackMoods"
    | "excludedRelPaths"
    | "excludedAlbumIds"
    | "settings"
  >
> & {
  /** Optimistic lock: the hub answers 409 when its revision moved on. */
  expectedRevision?: number;
};

export type HubHealth = {
  ok?: boolean;
  service?: string;
  version?: string;
  modules?: string[];
  scanning?: boolean;
  /** Wire protocol version (hubs from 5.2 on). */
  apiVersion?: number;
  /** Oldest client version this hub still talks to. */
  minClientVersion?: string;
  /** Transcoding support advertised by the hub. */
  transcode?: unknown;
};

export const api = {
  health: (opts?: CallOptions) =>
    // No account / JSON headers: a "simple" request needs no CORS preflight.
    fetchHub("/api/v1/health", { timeoutMs: 8000, ...opts, accountId: "", json: false }, (res) =>
      parseJsonBody<HubHealth>(res),
    ),
  stats: (opts?: CallOptions) => request<LibraryStats>("/api/v1/library/stats", opts),
  /** Library rescan. Incremental by default; `full` wipes and rebuilds. */
  scanLibrary: (mode: "incremental" | "full" = "incremental", opts?: CallOptions) =>
    request<ScanReport>(`/api/v1/library/scan?mode=${mode}`, {
      method: "POST",
      // The hub answers when the scan is over: as long as the disk needs.
      timeoutMs: null,
      ...opts,
    }),
  probeLibrary: () =>
    request<LibraryProbeReport>("/api/v1/library/probe", {
      method: "POST",
      timeoutMs: LONG_TIMEOUT_MS,
    }),
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
  tracksPage: (limit = 500, offset = 0, opts?: CallOptions) =>
    request<TrackPage>(`/api/v1/library/tracks-page?limit=${limit}&offset=${offset}`, {
      timeoutMs: 30_000,
      ...opts,
    }),
  artistsPage: (limit = 200, offset = 0) =>
    request<ArtistPage>(`/api/v1/library/artists-page?limit=${limit}&offset=${offset}`),
  /** Delta since a revision cursor; `full` asks the client to page again. */
  libraryChanges: (since?: string | null, opts?: CallOptions) =>
    request<LibraryChanges>(
      `/api/v1/library/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      { timeoutMs: 30_000, ...opts },
    ),
  /** Hub caps the limit at 500; the list is windowed, so ask for the full page. */
  search: (q: string, limit = 500, opts?: CallOptions) =>
    request<Track[]>(
      `/api/v1/library/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      opts,
    ),
  /**
   * Hub full-text search over title, artist, album and genre (never paths or
   * track-number prefixes): tracks plus matching albums and artists.
   */
  searchAll: (q: string, limit = 500, opts?: CallOptions) =>
    request<LibrarySearchAll>(
      `/api/v1/library/search?q=${encodeURIComponent(q)}&limit=${limit}&scope=all`,
      opts,
    ),
  /** Canonical genres of the account's library, most common first. */
  genres: (opts?: CallOptions) => request<LibraryGenre[]>("/api/v1/library/genres", opts),
  artists: (opts?: CallOptions) => request<Artist[]>("/api/v1/library/artists", opts),
  artist: (id: number) => request<Artist>(`/api/v1/library/artists/${id}`),
  artistAlbums: (id: number, opts?: CallOptions) =>
    request<Album[]>(`/api/v1/library/artists/${id}/albums`, opts),
  albums: (opts?: CallOptions) => request<Album[]>("/api/v1/library/albums", opts),
  album: (id: number) => request<Album>(`/api/v1/library/albums/${id}`),
  albumTracks: (id: number, opts?: CallOptions) =>
    request<Track[]>(`/api/v1/library/albums/${id}/tracks`, opts),
  track: (id: number) => request<Track>(`/api/v1/library/tracks/${id}`),
  favorites: (opts?: CallOptions) => request<Track[]>("/api/v1/favorites", opts),
  addFavorite: (track_id: number) =>
    request("/api/v1/favorites", {
      method: "POST",
      body: JSON.stringify({ track_id }),
    }),
  removeFavorite: (track_id: number) =>
    request(`/api/v1/favorites/${track_id}`, { method: "DELETE" }),
  playlists: (opts?: CallOptions) => request<Playlist[]>("/api/v1/playlists", opts),
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
  playlistTracks: (id: string, opts?: CallOptions) =>
    request<{ id: string; tracks: Track[] }>(`/api/v1/playlists/${id}`, opts),
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
  /** Info/curiosità for an artist (album omitted) or an album. Folder names. */
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
    const { blob, name } = await requestBlob(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/export`,
      {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        fallbackError: t("core.api.exportFailed"),
        fallbackName: "rekord-profile.zip",
      },
    );
    saveBlob(blob, name);
    return name;
  },

  /** Ensure a session account id is set from the server registry. */
  async ensureAccountSession(): Promise<AccountsResponse> {
    const data = await request<AccountsResponse>("/api/v1/accounts");
    rememberAvailableAccount(data);
    return data;
  },

  /** Download hub backup ZIP (blob + suggested filename). */
  async downloadBackup(): Promise<string> {
    const { blob, name } = await requestBlob("/api/v1/backup/kord-data", {
      timeoutMs: UPLOAD_TIMEOUT_MS,
      fallbackError: t("core.api.backupFailed"),
      fallbackName: "rekord-backup.zip",
    });
    saveBlob(blob, name);
    return name;
  },

  /** Download shareable theme ZIP for the current account. */
  async downloadThemeExport(): Promise<string> {
    const { blob, name } = await requestBlob("/api/v1/backup/theme-export", {
      timeoutMs: LONG_TIMEOUT_MS,
      fallbackError: t("core.api.themeExportFailed"),
      fallbackName: "rekord-theme.zip",
    });
    saveBlob(blob, name);
    return name;
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
      ? "/api/v1/backup/kord-restore?themeOnly=true"
      : "/api/v1/backup/kord-restore";
    return request<{
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
      }>(path, { method: "POST", body: fd, timeoutMs: UPLOAD_TIMEOUT_MS });
  },

  config: () => request<HubConfig>("/api/v1/config"),

  uploadYoutubeCookies: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<HubConfig>("/api/v1/config/youtube-cookies", {
      method: "POST",
      body: fd,
      timeoutMs: UPLOAD_TIMEOUT_MS,
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

  youtubeExploreSearch: (query: string, opts?: CallOptions) =>
    request<{ results: ExploreResult[] }>("/api/v1/youtube-explore-search", {
      method: "POST",
      body: JSON.stringify({ query }),
      timeoutMs: LONG_TIMEOUT_MS,
      ...opts,
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
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  catalogWebDiscover: (force = false, opts?: CallOptions) =>
    request<CatalogWebDiscover>(
      `/api/v1/catalog-web-discover${force ? "?force=1" : ""}`,
      { timeoutMs: LONG_TIMEOUT_MS, ...opts },
    ),

  catalogWebTracks: (url: string, opts?: CallOptions) =>
    request<CatalogWebTracks>(
      `/api/v1/catalog-web-tracks?url=${encodeURIComponent(url.trim())}`,
      { timeoutMs: LONG_TIMEOUT_MS, ...opts },
    ),

  /** Absolute `<audio src>` for a ~30s audition of a web catalog track. */
  catalogWebPreviewSrc: async (url: string, opts?: CallOptions) => {
    const { playUrl } = await request<{ playUrl: string }>(
      `/api/v1/catalog-web-preview?url=${encodeURIComponent(url.trim())}`,
      { timeoutMs: LONG_TIMEOUT_MS, ...opts },
    );
    return apiUrl(playUrl);
  },

  downloadFlatCount: (url: string) =>
    request<{ count: number }>("/api/v1/download-flat-count", {
      method: "POST",
      body: JSON.stringify({ url }),
      timeoutMs: LONG_TIMEOUT_MS,
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
    // A stream: no timer (a playlist download runs for many minutes), only
    // the caller's signal ends it. The response is handed out unread.
    const res = await fetchHub(
      "/api/v1/download",
      {
        method: "POST",
        body: JSON.stringify(body),
        signal,
        timeoutMs: null,
      },
      async (r) => {
        if (r.ok) return r;
        let env: Envelope<unknown> | null = null;
        try {
          env = (await r.json()) as Envelope<unknown>;
        } catch {
          /* ignore */
        }
        const detail = (env as { message?: string } | null)?.message ?? null;
        throw new ApiError(
          "http",
          env?.error || detail ? translateHubError(env?.error, detail) : r.statusText || `HTTP ${r.status}`,
          { status: r.status, code: env?.error ?? null, body: env },
        );
      },
    );
    const reader = res.body?.getReader();
    if (!reader) throw new Error(t("core.api.noStream"));
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

  artworkSearch: (
    opts: { q?: string; artist?: string; album?: string },
    call?: CallOptions,
  ) => {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.artist) p.set("artist", opts.artist);
    if (opts.album) p.set("album", opts.album);
    return request<{ results: ArtworkHit[] }>(`/api/v1/artwork/search?${p}`, {
      timeoutMs: LONG_TIMEOUT_MS,
      ...call,
    });
  },

  artworkApply: (albumPath: string, imageUrl: string) =>
    request<{ saved: boolean; coverRelPath?: string; coverVersion?: string | number }>("/api/v1/artwork/apply", {
      method: "POST",
      body: JSON.stringify({ albumPath, imageUrl }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  albumInfoFetch: (
    albumPath: string,
    artist?: string,
    album?: string,
    opts?: CallOptions,
  ) =>
    requestJson<{
      ok?: boolean;
      error?: string;
      albumPath: string;
      meta: Record<string, unknown>;
    }>("/api/v1/album-info/fetch", {
      method: "POST",
      body: JSON.stringify({ albumPath, artist, album }),
      timeoutMs: LONG_TIMEOUT_MS,
      ...opts,
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
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),

  pruneAlbumMetadata: (albumPath: string, opts?: CallOptions) =>
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
      timeoutMs: LONG_TIMEOUT_MS,
      ...opts,
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
      timeoutMs: LONG_TIMEOUT_MS,
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
        timeoutMs: LONG_TIMEOUT_MS,
      },
    ),

  /** Deletes the album folder whole: audio, cover and sidecars. */
  deleteAlbumFolder: (albumPath: string) =>
    request<{ deleted: string[]; deletedFolder: string; affectedAlbums: string[] }>(
      "/api/v1/fs/delete-album-folder",
      {
        method: "POST",
        body: JSON.stringify({ albumPath }),
        timeoutMs: LONG_TIMEOUT_MS,
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
        timeoutMs: LONG_TIMEOUT_MS,
      },
    ),

  discogsApplyRelease: (albumPath: string, releaseId: number, artist?: string, album?: string) =>
    requestJson<{ ok?: boolean; error?: string } & Record<string, unknown>>(
      "/api/v1/discogs/apply-release",
      {
        method: "POST",
        body: JSON.stringify({ albumPath, releaseId, artist, album }),
        timeoutMs: LONG_TIMEOUT_MS,
      },
    ),

  entityInfoSearch: (artist: string, album?: string | null, lang = "it") =>
    request<{ candidates: Array<{ kind?: string; lang: string; title?: string; text: string }> }>(
      "/api/v1/entity-info/search",
      {
        method: "POST",
        body: JSON.stringify({ artist, album: album || undefined, lang }),
        timeoutMs: LONG_TIMEOUT_MS,
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

  trackInfoFetch: (relPath: string, opts?: CallOptions) =>
    requestJson<{
      ok?: boolean;
      error?: string;
      meta?: Record<string, unknown>;
      lyrics?: string;
    }>("/api/v1/track-info/fetch", {
      method: "POST",
      body: JSON.stringify({ relPath }),
      timeoutMs: LONG_TIMEOUT_MS,
      ...opts,
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
      timeoutMs: LONG_TIMEOUT_MS,
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
    return request<{ saved?: boolean; coverRelPath?: string; coverVersion?: string | number }>("/api/v1/artwork/upload", {
      method: "POST",
      body: fd,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  getUserState: (opts?: CallOptions) =>
    request<UserStatePayload>("/api/v1/user-state", opts),

  getUserStateForAccount: (accountId: string) =>
    requestAsAccount<UserStatePayload>(accountId, "/api/v1/user-state"),

  favoritesForAccount: (accountId: string) =>
    requestAsAccount<Track[]>(accountId, "/api/v1/favorites"),

  playlistsForAccount: (accountId: string) =>
    requestAsAccount<Playlist[]>(accountId, "/api/v1/playlists"),

  /**
   * Resolves with the hub's new state (hubs before 5.2 may only return
   * `{ revision }`). With `expectedRevision` a stale write fails with an
   * `ApiError` of status 409; see `userStateConflict`.
   */
  patchUserState: (
    body: UserStatePatch | Record<string, unknown>,
    opts?: CallOptions & { keepalive?: boolean },
  ) =>
    request<Partial<UserStatePayload> & { revision: number }>("/api/v1/user-state", {
      method: "PATCH",
      body: JSON.stringify(body),
      ...opts,
    }),

  uploadCustomThemeBg: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{
      bgImage: string;
      bgImageRev: number;
    }>("/api/v1/user-state/custom-theme-bg", {
      method: "POST",
      body: fd,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  clearCustomThemeBg: async () => {
    await request<null>("/api/v1/user-state/custom-theme-bg", { method: "DELETE" });
  },

  /** Download and install the latest yt-dlp on the hub (machine operation). */
  updateYtdlp: (force = false) =>
    request<YtdlpUpdateResult>("/api/v1/tools/ytdlp/update", {
      method: "POST",
      body: JSON.stringify({ force }),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),

  diagnostics: () =>
    request<{
      binaries?: { ytdlp?: YtdlpInfo | null } & Record<string, unknown>;
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
        /** `"{kind}.{action}"` plus placeholders, when the hub wrote a coded line. */
        action?: string | null;
        code?: string | null;
        params?: Record<string, unknown> | null;
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
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  remoteStop: () =>
    request<RemoteAccessState>("/api/v1/remote-access/stop", {
      method: "POST",
      body: "{}",
      timeoutMs: LONG_TIMEOUT_MS,
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
};

export type RemoteAccessStatus = "stopped" | "starting" | "running" | "error";

export type RemoteAccessState = {
  enabled: boolean;
  status: RemoteAccessStatus;
  provider: string;
  publicUrl: string | null;
  error: string | null;
  /** Stable code for `error` (cloudflared_not_found, tunnel_start_timeout, …). */
  errorCode?: string | null;
  startedAt: string | null;
  cloudflaredPath: string | null;
  cloudflareLoggedIn: boolean;
  lanUrl: string | null;
  bind: string;
  cloudflaredAvailable: boolean;
};
