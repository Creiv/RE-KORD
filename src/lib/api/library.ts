import type {
  DashboardPayload,
  DiscogsAlbumExtra,
  EntityInfoBundle,
  EntityInfoCandidate,
  EntityInfoItem,
  LibraryCatalogResponse,
  LibraryEntityDelta,
  LibraryIndex,
  LibrarySelectionV1,
} from "../../types"
import {
  apiFetch,
  apiUrl,
  ensureSelectedAccountId,
  unwrap,
} from "./core"

export type LibrarySnapshotResponse = {
  index: LibraryIndex
  dashboard: DashboardPayload
}

export async function fetchLibrarySnapshot(): Promise<LibrarySnapshotResponse> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/library-snapshot", { cache: "no-store" })
  return unwrap<LibrarySnapshotResponse>(response)
}

export type LibraryDeltaResponse = {
  changed: boolean
  indexEpoch: number
  removedTrackPaths: string[]
  addedTrackPaths: string[]
  updatedAlbums: LibraryIndex["albums"]
  updatedTracks?: LibraryIndex["tracks"]
  fullRefreshRecommended?: boolean
}

export async function fetchLibraryDelta(
  sinceEpoch: number,
): Promise<LibraryDeltaResponse> {
  const response = await apiFetch(
    "/api/library/delta",
    { cache: "no-store" },
    { sinceEpoch: String(sinceEpoch) },
  )
  return unwrap<LibraryDeltaResponse>(response)
}

export type LibrarySearchResponse = {
  artists: LibraryIndex["artists"]
  albums: LibraryIndex["albums"]
  tracks: LibraryIndex["tracks"]
}

export async function searchLibrary(
  q: string,
  signal?: AbortSignal,
): Promise<LibrarySearchResponse> {
  const query = q.trim()
  if (!query) return { artists: [], albums: [], tracks: [] }
  await ensureSelectedAccountId()
  const response = await apiFetch(
    "/api/library-search",
    { cache: "no-store", signal },
    { q: query },
  )
  return unwrap<LibrarySearchResponse>(response)
}

export type PaginatedArtistsResponse = {
  artists: LibraryIndex["artists"]
  offset: number
  limit: number
  indexEpoch: number
}

export async function fetchArtistsPage(opts: {
  offset?: number
  limit?: number
  sort?: "name" | "tracks"
} = {}): Promise<PaginatedArtistsResponse> {
  await ensureSelectedAccountId()
  const query: Record<string, string> = {}
  if (opts.offset != null) query.offset = String(opts.offset)
  if (opts.limit != null) query.limit = String(opts.limit)
  if (opts.sort) query.sort = opts.sort
  const response = await apiFetch("/api/library/artists-page", { cache: "no-store" }, query)
  return unwrap<PaginatedArtistsResponse>(response)
}

export async function fetchArtistAlbums(artistId: string): Promise<{
  artistId: string
  albums: LibraryIndex["albums"]
}> {
  await ensureSelectedAccountId()
  const response = await apiFetch(
    `/api/library/artists/${encodeURIComponent(artistId)}/albums-list`,
    { cache: "no-store" },
  )
  return unwrap<{ artistId: string; albums: LibraryIndex["albums"] }>(response)
}

export async function fetchAlbumTracks(relPath: string): Promise<{
  album: LibraryIndex["albums"][number]
  tracks: LibraryIndex["tracks"]
}> {
  await ensureSelectedAccountId()
  const response = await apiFetch(
    "/api/library/album-tracks",
    { cache: "no-store" },
    { relPath },
  )
  return unwrap<{ album: LibraryIndex["albums"][number]; tracks: LibraryIndex["tracks"] }>(
    response,
  )
}

export type LibraryChangesResponse = {
  changed: boolean
  indexEpoch: number
  scanning?: boolean
  lastScanAt?: string | null
}

export async function fetchLibraryChanges(
  sinceEpoch: number,
): Promise<LibraryChangesResponse> {
  const response = await apiFetch(
    "/api/library/changes",
    { cache: "no-store" },
    { sinceEpoch: String(sinceEpoch) },
  )
  return unwrap<LibraryChangesResponse>(response)
}

export async function probeLibraryStructure(
  musicRoot: string,
  sampleLimit = 200,
): Promise<{
  stats: Record<string, number>
  candidates: { layout: string; confidence: number; reason: string }[]
  warnings: string[]
  suggestedLayout: Record<string, unknown>
}> {
  const response = await apiFetch("/api/library/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ musicRoot, sampleLimit }),
  })
  return unwrap(response)
}

export async function waitForLibraryEpoch(
  afterEpoch: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pollMs = opts.pollMs ?? 400
  const start = Date.now()
  let last = afterEpoch
  while (Date.now() - start < timeoutMs) {
    const snap = await fetchLibraryChanges(last)
    if (snap.indexEpoch > afterEpoch && !snap.scanning) return snap.indexEpoch
    last = snap.indexEpoch
    await new Promise((r) => setTimeout(r, pollMs))
  }
  const final = await fetchLibraryChanges(afterEpoch)
  return final.indexEpoch
}

export async function fetchLibraryCatalog(opts: { summary?: boolean; artistId?: string } = {}): Promise<LibraryCatalogResponse> {
  await ensureSelectedAccountId()
  const query: Record<string, string> = {}
  if (opts.summary) query.summary = "1"
  if (opts.artistId) query.artistId = opts.artistId
  const response = await apiFetch("/api/catalog", { cache: "no-store" }, query)
  return unwrap<LibraryCatalogResponse>(response)
}

type CatalogWebDiscoverEntry = {
  id: string
  type?: 'album' | 'song'
  title: string
  subtitle: string
  url: string
  thumbnailUrl?: string | null
}

export type CatalogWebDiscoverAlbum = CatalogWebDiscoverEntry & {
  artistName: string
  releaseType?: string | null
  trackCount?: number | null
}

export type CatalogWebDiscoverSong = CatalogWebDiscoverEntry & {
  artistName: string
  releaseType?: string | null
}

export type CatalogWebDiscoverResponse = {
  artists: CatalogWebDiscoverEntry[]
  albums: CatalogWebDiscoverAlbum[]
  songs: CatalogWebDiscoverSong[]
  error?: string | null
}

export async function fetchCatalogWebDiscover(
  opts: { force?: boolean } = {},
): Promise<CatalogWebDiscoverResponse> {
  await ensureSelectedAccountId()
  const response = await apiFetch(
    "/api/catalog-web-discover",
    { cache: "no-store" },
    opts.force ? { force: "1" } : {},
  )
  return unwrap<CatalogWebDiscoverResponse>(response)
}

export type CatalogWebTrack = {
  id: string
  title: string
  url: string
}

export async function fetchCatalogWebTracks(
  pageUrl: string,
): Promise<{
  tracks: CatalogWebTrack[]
  title: string | null
  error?: string | null
}> {
  await ensureSelectedAccountId()
  const response = await apiFetch(
    "/api/catalog-web-tracks",
    { cache: "no-store" },
    { url: pageUrl.trim() },
  )
  return unwrap<{
    tracks: CatalogWebTrack[]
    title: string | null
    error?: string | null
  }>(response)
}

/** URL per `<audio src>`: streaming via proxy token (affidabile anche su Windows). */
export async function catalogWebPreviewAudioSrc(
  watchUrl: string,
): Promise<string> {
  const { playUrl } = await fetchCatalogWebPreviewPlayUrl(watchUrl)
  return apiUrl(playUrl)
}

async function fetchCatalogWebPreviewPlayUrl(
  watchUrl: string,
): Promise<{ playUrl: string }> {
  await ensureSelectedAccountId()
  const response = await apiFetch(
    "/api/catalog-web-preview",
    { cache: "no-store" },
    { url: watchUrl.trim() },
  )
  return unwrap<{ playUrl: string }>(response)
}

export async function fetchMyLibrarySelection(): Promise<LibrarySelectionV1> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/my-library-selection", {
    cache: "no-store",
  })
  return unwrap<LibrarySelectionV1>(response)
}

export async function patchMyLibrarySelection(
  patch: Partial<{
    includeAll: boolean
    addArtists: string[]
    removeArtists: string[]
    addAlbums: string[]
    removeAlbums: string[]
    addTracks: string[]
    removeTracks: string[]
  }>,
): Promise<LibrarySelectionV1> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/my-library-selection", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  return unwrap<LibrarySelectionV1>(response)
}

export async function fetchDashboard(): Promise<DashboardPayload> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/dashboard", { cache: "no-store" })
  return unwrap<DashboardPayload>(response)
}

export type FsList = {
  path: string
  parent: string
  dirs: { name: string; relPath: string }[]
  musicRoot: string
}

export type FsDirSearchResult = {
  name: string
  relPath: string
}

export async function listMusicDirs(path: string): Promise<FsList> {
  const response = await apiFetch("/api/fs/list", {}, { path: path || "" })
  return unwrap<FsList>(response)
}

export async function searchMusicDirs(q: string): Promise<FsDirSearchResult[]> {
  const query = q.trim()
  if (!query) return []
  const response = await apiFetch("/api/fs/search-dirs", {}, { q: query })
  const data = await unwrap<{ results: FsDirSearchResult[] }>(response)
  return data.results || []
}

export async function deleteAudioRelPaths(
  relPaths: string[],
): Promise<{ deleted: string[]; affectedAlbums?: string[] }> {
  const response = await apiFetch("/api/fs/delete-audio-relpaths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPaths }),
  })
  return unwrap<{ deleted: string[]; affectedAlbums?: string[] }>(response)
}

export async function deleteAlbumFolder(
  albumPath: string,
): Promise<{ deleted: string[]; deletedFolder: string; affectedAlbums?: string[] }> {
  const response = await apiFetch("/api/fs/delete-album-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath }),
  })
  return unwrap<{ deleted: string[]; deletedFolder: string; affectedAlbums?: string[] }>(response)
}

export type ArtworkHit = {
  name: string
  artist: string
  artwork: string
  url: string
  source?: string
}

export async function searchArtwork(
  opts: { q?: string; artist?: string; album?: string } | string,
): Promise<ArtworkHit[]> {
  const flat: Record<string, string> = {}
  if (typeof opts === "string") {
    flat.q = opts
  } else {
    if (opts.q) flat.q = opts.q
    if (opts.artist) flat.artist = opts.artist
    if (opts.album) flat.album = opts.album
  }
  if (!Object.keys(flat).length) return []
  const response = await apiFetch("/api/artwork/search", {}, flat)
  const data = await unwrap<{ results: ArtworkHit[] }>(response)
  return data.results || []
}

export async function applyArtwork(
  albumPath: string,
  imageUrl: string,
): Promise<LibraryEntityDelta & { saved: string; abs?: string }> {
  const response = await apiFetch("/api/artwork/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath, imageUrl }),
  })
  return unwrap<LibraryEntityDelta & { saved: string; abs?: string }>(response)
}

/** Upload manuale cover album (JPEG/PNG) dalla pagina album. */
export async function uploadAlbumCover(
  albumPath: string,
  file: File,
): Promise<LibraryEntityDelta & { saved: string; abs?: string }> {
  const fd = new FormData()
  fd.append("albumPath", albumPath)
  fd.append("file", file)
  const response = await apiFetch("/api/artwork/upload", {
    method: "POST",
    body: fd,
  })
  return unwrap<LibraryEntityDelta & { saved: string; abs?: string }>(response)
}

export async function createMusicSubdir(
  parent: string,
  name: string,
): Promise<{ relPath: string }> {
  const response = await apiFetch("/api/fs/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent, name }),
  })
  const json = await unwrap<{ relPath?: string }>(response)
  return { relPath: json.relPath || "" }
}

export type FetchedAlbumMeta = {
  ok: boolean
  title?: string | null
  musicbrainzReleaseId?: string
  discogsReleaseId?: number | null
  discogsUri?: string | null
  discogsExtra?: DiscogsAlbumExtra | null
  date: string | null
  country: string | null
  label: string | null
  genre?: string | null
  formatSummary?: string | null
  catalogNo?: string | null
  fetchedAt?: string
  expectedTrackCount?: number
  expectedTracks?: { disc?: number; position?: number | null; title: string }[]
}

export type { DiscogsAlbumExtra }

export type AlbumMetaSavePatch = {
  title?: string | null
  releaseDate?: string | null
  genre?: string | null
  label?: string | null
  country?: string | null
  musicbrainzReleaseId?: string | null
}

export type FetchedTrackMeta = {
  ok: boolean
  title?: string
  releaseDate: string | null
  genre: string | null
  lyrics?: string | null
  durationMs: number | null
  trackNumber: number | null
  discNumber: number | null
  source: string | null
  url: string | null
  fetchedAt?: string
}

export async function fetchAlbumInfo(
  albumPath: string,
  artist: string,
  album: string,
): Promise<{
  ok: true;
  albumPath: string;
  meta: FetchedAlbumMeta;
  album?: LibraryEntityDelta["album"];
}> {
  const response = await apiFetch("/api/album-info/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath, artist, album }),
  })
  return unwrap<{
    ok: true;
    albumPath: string;
    meta: FetchedAlbumMeta;
    album?: LibraryEntityDelta["album"];
  }>(response)
}

export async function saveAlbumInfoManual(
  albumPath: string,
  patch: AlbumMetaSavePatch,
): Promise<{ albumPath: string; meta: Record<string, unknown>; album?: LibraryEntityDelta["album"]; tracks?: LibraryEntityDelta["tracks"] }> {
  const response = await apiFetch("/api/album-info/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath, patch }),
  })
  const data = await unwrap<{ albumPath: string; meta: Record<string, unknown>; album?: LibraryEntityDelta["album"]; tracks?: LibraryEntityDelta["tracks"] }>(
    response,
  )
  return data
}

/** Info/curiosità per artista (album omesso) o album. `artist` e `album` sono nomi cartella. */
export async function getEntityInfo(
  artist: string,
  album?: string | null,
): Promise<EntityInfoBundle> {
  const response = await apiFetch("/api/entity-info", undefined, {
    artist,
    ...(album ? { album } : {}),
  })
  const data = await unwrap<EntityInfoBundle>(response)
  return {
    items: Array.isArray(data.items) ? data.items : [],
    image: data.image ?? null,
  }
}

export async function searchEntityInfo(
  artist: string,
  album?: string | null,
  lang?: string,
): Promise<EntityInfoCandidate[]> {
  const response = await apiFetch("/api/entity-info/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist, album: album || undefined, lang }),
  })
  const data = await unwrap<{ candidates: EntityInfoCandidate[] }>(response)
  return Array.isArray(data.candidates) ? data.candidates : []
}

/** Aggiunge/rimuove voci; per gli artisti può scaricare la foto (imageUrl). */
export async function saveEntityInfo(
  artist: string,
  album: string | null,
  ops: {
    add?: Pick<EntityInfoItem, "lang" | "title" | "text">[];
    removeIds?: string[];
    imageUrl?: string | null;
  },
): Promise<EntityInfoBundle> {
  const response = await apiFetch("/api/entity-info/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artist,
      album: album || undefined,
      add: ops.add ?? [],
      removeIds: ops.removeIds ?? [],
      imageUrl: ops.imageUrl || undefined,
    }),
  })
  const data = await unwrap<EntityInfoBundle>(response)
  return {
    items: Array.isArray(data.items) ? data.items : [],
    image: data.image ?? null,
  }
}

export async function fetchTrackInfo(
  relPath: string,
): Promise<{
  ok: true;
  relPath: string;
  meta: FetchedTrackMeta;
  track?: LibraryEntityDelta["track"];
}> {
  const response = await apiFetch("/api/track-info/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath }),
  })
  return unwrap<{
    ok: true;
    relPath: string;
    meta: FetchedTrackMeta;
    track?: LibraryEntityDelta["track"];
  }>(response)
}

export async function fetchAlbumTracksInfo(
  albumPath: string,
  artist?: string,
  album?: string,
): Promise<{
  albumPath: string;
  fetched: number;
  failed: number;
  tracks: LibraryEntityDelta["track"][];
  errors: { relPath: string; error: string }[];
}> {
  const response = await apiFetch("/api/track-info/fetch-album", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath, artist, album }),
  })
  return unwrap(response)
}

export async function fetchTrackLyrics(
  relPath: string,
): Promise<{ ok: true; relPath: string; syncedLyrics: string | null; plainLyrics: string | null }> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/track-lyrics/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath }),
  })
  return unwrap<{ ok: true; relPath: string; syncedLyrics: string | null; plainLyrics: string | null }>(response)
}

export type TrackMetaSavePatch = {
  title?: string | null;
  releaseDate?: string | null;
  genre?: string | null;
  lyrics?: string | null;
  /** true se AUTO LRC è stato eseguito senza trovare testo */
  lyricsAutoChecked?: boolean;
  /** fino a 3 id canonici; `null` o `[]` azzera. */
  moods?: string[] | null;
  /** compat salvataggi vecchi */
  mood?: string | null;
  durationMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  source?: string | null;
  url?: string | null;
};

export async function saveTrackInfoManual(
  relPath: string,
  patch: TrackMetaSavePatch,
): Promise<{ ok: true; relPath: string; meta: Record<string, unknown>; track?: LibraryEntityDelta["track"]; album?: LibraryEntityDelta["album"] }> {
  const response = await apiFetch("/api/track-info/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath, patch }),
  })
  return unwrap<{ ok: true; relPath: string; meta: Record<string, unknown>; track?: LibraryEntityDelta["track"]; album?: LibraryEntityDelta["album"] }>(response)
}

export async function savePlectrBestScore(
  relPath: string,
  result: {
    score: number;
    grade: string;
    accuracy: number;
    maxCombo: number;
    hits?: number;
    misses?: number;
    updatedAt?: string;
  },
): Promise<{
  ok: true;
  relPath: string;
  meta: Record<string, unknown>;
  track?: LibraryEntityDelta["track"];
}> {
  const response = await apiFetch("/api/plectr/save-best", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath, result }),
  });
  return unwrap<{
    ok: true;
    relPath: string;
    meta: Record<string, unknown>;
    track?: LibraryEntityDelta["track"];
  }>(response);
}

export async function pruneAlbumLibraryMetadataForAlbum(
  albumPath: string,
): Promise<{
  albumPath: string;
  removed: string[];
  written: boolean;
  expectedTracksCleared: boolean;
  trackOrderingFieldsCleared: number;
  albumFieldsMerged: number;
  tracksMerged: number;
  jsonFilesRemoved: number;
  jsonFilesTrimmed: number;
}> {
  const response = await apiFetch("/api/track-info/prune-orphans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albumPath }),
  })
  return unwrap<{
    albumPath: string;
    removed: string[];
    written: boolean;
    expectedTracksCleared: boolean;
    trackOrderingFieldsCleared: number;
    albumFieldsMerged: number;
    tracksMerged: number;
    jsonFilesRemoved: number;
    jsonFilesTrimmed: number;
  }>(response)
}
