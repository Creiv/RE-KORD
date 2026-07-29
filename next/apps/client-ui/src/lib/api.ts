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

export function albumCoverUrl(albumId: number): string {
  return apiUrl(`/api/v1/covers/album/${albumId}`);
}

export function artistCoverUrl(artistId: number): string {
  return apiUrl(`/api/v1/covers/artist/${artistId}`);
}

export type Envelope<T> = { ok: boolean; data?: T; error?: string };

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
  genre?: string | null;
  release_date?: string | null;
  label?: string | null;
  /** Tracce attese da catalogo/Discogs (come `expectedTrackCount` React). */
  expected_track_count?: number | null;
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
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || !body.ok) {
    throw new Error(body.error || res.statusText);
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
  const res = await fetch(url, { ...init, headers });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || !body.ok) {
    throw new Error(body.error || res.statusText);
  }
  return body.data as T;
}

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
  health: () => fetch(apiUrl("/api/v1/health")).then((r) => r.json()),
  stats: () => request<LibraryStats>("/api/v1/library/stats"),
  tracks: (limit = 500, offset = 0) =>
    request<Track[]>(`/api/v1/library?limit=${limit}&offset=${offset}`),
  search: (q: string) =>
    request<Track[]>(`/api/v1/library/search?q=${encodeURIComponent(q)}`),
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
      const body = (await res.json()) as Envelope<{
        restored?: boolean;
        version?: number;
        favorites?: number;
        playlists?: number;
        playlist_tracks?: number;
        library_files?: number;
        scanned_tracks?: number;
        themeImported?: boolean;
        theme?: string | null;
        glassSurfaces?: boolean;
        glassOpacity?: number;
      }>;
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
      const body = (await res.json()) as Envelope<HubConfig>;
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
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || res.statusText);
      }
      return body as { ok?: boolean; albumPath: string; meta: Record<string, unknown> };
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
      const body = await res.json();
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
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || res.statusText);
      return body as { meta?: Record<string, unknown>; lyrics?: string };
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
      const body = (await res.json()) as Envelope<{ saved?: boolean; coverRelPath?: string }>;
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
      const body = (await res.json()) as Envelope<{
        bgImage: string;
        bgImageRev: number;
      }>;
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
    const body = (await res.json()) as Envelope<null>;
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

  activityLog: () =>
    request<{ entries: Array<{ ts: string; kind: string; message: string }> }>(
      "/api/v1/activity-log",
    ),

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
