import type { Album, CatalogArtistEntry, LibrarySelectionV1 } from "./api";

export function selectionHasArtist(
  sel: LibrarySelectionV1 | null,
  artistId: string,
): boolean {
  if (!sel) return false;
  if (sel.includeAll) return true;
  return sel.artists.includes(artistId);
}

export function selectionHasAlbum(
  sel: LibrarySelectionV1 | null,
  albumFolderKey: string,
  artistId: string,
): boolean {
  if (!sel) return false;
  if (sel.includeAll) return true;
  if (sel.artists.includes(artistId)) return true;
  return sel.albums.includes(albumFolderKey);
}

export function indexHasAlbum(albums: Album[] | null | undefined, folderKey: string): boolean {
  if (!albums?.length) return false;
  return albums.some((a) => a.folder_key === folderKey);
}

export function indexHasArtist(
  artists: { name: string }[] | null | undefined,
  artistId: string,
): boolean {
  if (!artists?.length) return false;
  return artists.some((a) => a.name === artistId);
}

/** Artista non in selezione, oppure almeno un album catalogo mancante nella libreria filtrata. */
export function catalogArtistNeedsAttention(
  ar: CatalogArtistEntry,
  libraryAlbums: Album[] | null | undefined,
  sel: LibrarySelectionV1 | null,
): boolean {
  const notInSelection = !selectionHasArtist(sel, ar.id);
  const missingAlbum =
    ar.rel_albums.length > 0 &&
    ar.rel_albums.some((al) => !indexHasAlbum(libraryAlbums, al.folder_key));
  return notInSelection || missingAlbum;
}
