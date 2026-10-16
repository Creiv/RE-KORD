/**
 * The library as Studio's "In libreria" matcher sees it, rebuilt only when the
 * album list or the catalog changes (both are `$state.raw` arrays, replaced on
 * reload). Call it inside `$derived` so components follow the reloads.
 */
import { session } from "../session.svelte";
import { buildLibraryIndex, libraryHitFor, type LibraryHit, type LibraryIndex } from "./libraryMatch";

let cache: { albums: unknown; tracks: unknown; idx: LibraryIndex } | null = null;

export function studioLibraryIndex(): LibraryIndex {
  const albums = session.allAlbums;
  const tracks = session.catalogTracks;
  if (cache && cache.albums === albums && cache.tracks === tracks) return cache.idx;
  const idx = buildLibraryIndex(albums, tracks);
  cache = { albums, tracks, idx };
  return idx;
}

export function studioLibraryHit(item: {
  kind: "album" | "song";
  title: string;
  subtitle?: string | null;
  artist?: string | null;
}): LibraryHit | null {
  return libraryHitFor(studioLibraryIndex(), item);
}
