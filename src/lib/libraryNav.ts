import type {
  EnrichedTrack,
  LibraryAlbumIndex,
  LibraryIndex,
  LibraryTrackIndex,
  PlectrBestScore,
} from "../types"

export const LOOSE_ALBUM_ID = "__loose__"
export const LOOSE_ALBUM_FOLDER = "Tracks"
const LOOSE_ALBUM_NAMES = new Set([LOOSE_ALBUM_FOLDER, "Tracce"])

export function isLooseAlbumName(name: string | null | undefined): boolean {
  return LOOSE_ALBUM_NAMES.has(String(name || "").trim())
}

export function isLooseAlbum(
  album: Pick<LibraryAlbumIndex, "loose" | "name" | "id"> | null | undefined,
): boolean {
  if (!album) return false
  return Boolean(album.loose) || album.id === LOOSE_ALBUM_ID || isLooseAlbumName(album.name)
}

export function isLooseTrack(track: Pick<EnrichedTrack, "album" | "relPath">): boolean {
  if (isLooseAlbumName(track.album)) return true
  const parts = track.relPath.split("/").filter(Boolean)
  return parts.length >= 3 && LOOSE_ALBUM_NAMES.has(parts[1]!)
}

export function artistAlbumsFor(
  index: LibraryIndex,
  artistId: string,
): LibraryAlbumIndex[] {
  return index.albums.filter((album) => album.artistId === artistId)
}

export function artistHasOnlyLooseAlbum(
  index: LibraryIndex,
  artistId: string,
): boolean {
  const albums = artistAlbumsFor(index, artistId)
  return albums.length === 1 && isLooseAlbum(albums[0])
}

export function soleLooseAlbumForArtist(
  index: LibraryIndex,
  artistId: string,
): LibraryAlbumIndex | null {
  const albums = artistAlbumsFor(index, artistId)
  if (albums.length !== 1 || !isLooseAlbum(albums[0])) return null
  return albums[0]!
}

export function resolveLibraryAlbumRoute(
  index: LibraryIndex,
  artistId: string,
  albumName: string | null | undefined,
): string | null {
  if (albumName) return albumName
  return soleLooseAlbumForArtist(index, artistId)?.name ?? null
}

export function openArtistInLibrary(
  index: LibraryIndex,
  artistId: string,
  onOpenArtist: (artistId: string) => void,
  onOpenAlbum: (artistId: string, albumName: string) => void,
): void {
  const loose = soleLooseAlbumForArtist(index, artistId)
  if (loose) {
    onOpenAlbum(artistId, loose.name)
    return
  }
  onOpenArtist(artistId)
}

export function resolveTrackAlbumName(
  index: LibraryIndex,
  track: Pick<
    EnrichedTrack,
    "album" | "albumId" | "albumFolderRelPath" | "relPath"
  >,
): string {
  if (track.albumId) {
    const byId = index.albums.find((album) => album.id === track.albumId)
    if (byId?.name) return byId.name
  }
  if (track.albumFolderRelPath) {
    const byFolder = index.albums.find(
      (album) => album.relPath === track.albumFolderRelPath,
    )
    if (byFolder?.name) return byFolder.name
  }
  const parts = track.relPath.split("/").filter(Boolean)
  if (parts.length >= 2) {
    const albumRel = parts.slice(0, -1).join("/")
    const byRel = index.albums.find((album) => album.relPath === albumRel)
    if (byRel?.name) return byRel.name
  }
  return track.album
}

export function openTrackInLibrary(
  index: LibraryIndex,
  track: EnrichedTrack,
  _onOpenArtist: (artistId: string) => void,
  onOpenAlbum: (artistId: string, albumName: string) => void,
): void {
  const artist = index.artists.find(
    (item) => item.id === track.artist || item.name === track.artist,
  )
  const artistId = artist?.id ?? track.artist
  const albumName = resolveTrackAlbumName(index, track)
  if (isLooseTrack(track) || artistHasOnlyLooseAlbum(index, artistId)) {
    onOpenAlbum(
      artistId,
      resolveLibraryAlbumRoute(index, artistId, albumName) ?? albumName,
    )
    return
  }
  onOpenAlbum(artistId, albumName)
}

export function formatTrackByline(track: EnrichedTrack): string {
  if (isLooseTrack(track)) return track.artist
  return `${track.artist} · ${track.album}`
}

export function legacyLooseRelPath(relPath: string): string {
  return relPath.replace("/Tracce/", "/Tracks/")
}

export function legacyLooseRelPathReverse(relPath: string): string {
  return relPath.replace("/Tracks/", "/Tracce/")
}

/** Varianti uniche di un relPath loose (originale, Tracce→Tracks, Tracks→Tracce). */
export function looseRelPathAliases(relPath: string): string[] {
  const migrated = legacyLooseRelPath(relPath)
  const legacy = legacyLooseRelPathReverse(relPath)
  return [...new Set([relPath, migrated, legacy].filter(Boolean))]
}

export function relPathSetHas(
  set: ReadonlySet<string>,
  relPath: string,
): boolean {
  for (const alias of looseRelPathAliases(relPath)) {
    if (set.has(alias)) return true
  }
  return false
}

export function lookupByRelPathAliases<T>(
  record: Record<string, T> | undefined,
  relPath: string,
): T | undefined {
  if (!record) return undefined
  for (const alias of looseRelPathAliases(relPath)) {
    if (alias in record) return record[alias]
  }
  return undefined
}

export function findLibraryTrackByRelPath(
  tracks: readonly LibraryTrackIndex[],
  relPath: string,
): LibraryTrackIndex | undefined {
  const lookup = buildLibraryTrackLookup(tracks)
  for (const alias of looseRelPathAliases(relPath)) {
    const hit = lookup.byRelPath.get(alias)
    if (hit) return hit
  }
  return undefined
}

export function isFavoriteRelPath(
  favorites: ReadonlySet<string>,
  relPath: string,
): boolean {
  return relPathSetHas(favorites, relPath)
}

function uniqRelPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function pickBetterPlectrBest(
  a: PlectrBestScore,
  b: PlectrBestScore,
): PlectrBestScore {
  if (a.score !== b.score) return a.score > b.score ? a : b
  return (a.accuracy ?? 0) >= (b.accuracy ?? 0) ? a : b
}

function migrateTrackPlayCounts(
  counts: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(counts || {})) {
    if (!key || !Number.isFinite(count) || count <= 0) continue
    const migrated = legacyLooseRelPath(key)
    out[migrated] = (out[migrated] ?? 0) + count
  }
  return out
}

function migratePlectrBestsRecord(
  bests: Record<string, PlectrBestScore> | undefined,
): Record<string, PlectrBestScore> {
  const out: Record<string, PlectrBestScore> = {}
  for (const [key, best] of Object.entries(bests || {})) {
    if (!key || !best) continue
    const migrated = legacyLooseRelPath(key)
    const prev = out[migrated]
    out[migrated] = prev ? pickBetterPlectrBest(prev, best) : best
  }
  return out
}

/** Migra path loose Tracce → Tracks in user state (una tantum). */
export function migrateLooseTrackPathsInUserState<T extends import("../types").UserStateV1>(
  state: T,
): T {
  if (state.loosePathsMigrated) return state
  const mapRel = (p: string) => legacyLooseRelPath(p)
  const favorites = uniqRelPaths((state.favorites || []).map(mapRel))
  const recent = (state.recent || []).map((track) => {
    const relPath = mapRel(track.relPath)
    return relPath === track.relPath ? track : { ...track, relPath }
  })
  const queueTracks = (state.queue?.tracks || []).map((track) => {
    const relPath = mapRel(track.relPath)
    return relPath === track.relPath ? track : { ...track, relPath }
  })
  const playlists = (state.playlists || []).map((pl) => ({
    ...pl,
    tracks: (pl.tracks || []).map((track) => {
      const relPath = mapRel(track.relPath)
      return relPath === track.relPath ? track : { ...track, relPath }
    }),
  }))
  return {
    ...state,
    favorites,
    recent,
    queue: { ...state.queue, tracks: queueTracks },
    playlists,
    shuffleExcludedTrackRelPaths: uniqRelPaths(
      (state.shuffleExcludedTrackRelPaths || []).map(mapRel),
    ),
    trackPlayCounts: migrateTrackPlayCounts(state.trackPlayCounts),
    plectrBests: migratePlectrBestsRecord(state.plectrBests),
    loosePathsMigrated: true,
  }
}

export function trackPlaybackKey(track: {
  relPath: string
  filePath?: string | null
}): string {
  return track.filePath?.trim() || track.relPath
}

export function resolveTrackFromLibrary<T extends EnrichedTrack>(
  seed: T,
  libraryTracks: readonly T[],
): T {
  const byRel = new Map(libraryTracks.map((track) => [track.relPath, track]))
  const byFile = new Map(
    libraryTracks
      .filter((track) => track.filePath?.trim())
      .map((track) => [track.filePath!.trim(), track]),
  )
  const direct = byRel.get(seed.relPath)
  if (direct) return direct
  const migrated = byRel.get(legacyLooseRelPath(seed.relPath))
  if (migrated) return migrated
  const legacy = byRel.get(seed.relPath.replace("/Tracks/", "/Tracce/"))
  if (legacy) return legacy
  if (seed.filePath?.trim()) {
    const fromFile = byFile.get(seed.filePath.trim())
    if (fromFile) return fromFile
  }
  return seed
}

/** Allinea brani da user state (recenti, playlist stub) con l'indice libreria corrente. */
export function enrichTracksFromLibrary<T extends EnrichedTrack>(
  seeds: readonly T[],
  libraryTracks: readonly T[],
): T[] {
  if (!libraryTracks.length) return [...seeds]
  return seeds.map((seed) => resolveTrackFromLibrary(seed, libraryTracks))
}

export function buildLibraryTrackLookup(tracks: readonly LibraryTrackIndex[]) {
  const byRelPath = new Map<string, LibraryTrackIndex>()
  const byFilePath = new Map<string, LibraryTrackIndex>()
  for (const track of tracks) {
    byRelPath.set(track.relPath, track)
    const migrated = legacyLooseRelPath(track.relPath)
    if (migrated !== track.relPath) byRelPath.set(migrated, track)
    if (track.filePath?.trim()) byFilePath.set(track.filePath.trim(), track)
  }
  return { byRelPath, byFilePath }
}

export function lookupLibraryTrack(
  lookup: ReturnType<typeof buildLibraryTrackLookup>,
  track: Pick<EnrichedTrack, "relPath" | "filePath">,
): LibraryTrackIndex | undefined {
  return (
    lookup.byRelPath.get(track.relPath) ??
    lookup.byRelPath.get(legacyLooseRelPath(track.relPath)) ??
    (track.filePath?.trim()
      ? lookup.byFilePath.get(track.filePath.trim())
      : undefined)
  )
}
