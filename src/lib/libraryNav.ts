import type {
  EnrichedTrack,
  LibraryAlbumIndex,
  LibraryArtistIndex,
  LibraryIndex,
  LibraryTrackIndex,
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

export function openTrackInLibrary(
  index: LibraryIndex,
  track: EnrichedTrack,
  onOpenArtist: (artistId: string) => void,
  onOpenAlbum: (artistId: string, albumName: string) => void,
): void {
  const artist = index.artists.find(
    (item) => item.id === track.artist || item.name === track.artist,
  )
  const artistId = artist?.id ?? track.artist
  if (isLooseTrack(track) || artistHasOnlyLooseAlbum(index, artistId)) {
    const albumName =
      resolveLibraryAlbumRoute(index, artistId, track.album) ?? track.album
    onOpenAlbum(artistId, albumName)
    return
  }
  onOpenAlbum(artistId, track.album)
}

export function formatTrackByline(track: EnrichedTrack): string {
  if (isLooseTrack(track)) return track.artist
  return `${track.artist} · ${track.album}`
}

export function legacyLooseRelPath(relPath: string): string {
  return relPath.replace("/Tracce/", "/Tracks/")
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
