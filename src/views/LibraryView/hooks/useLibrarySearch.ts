import { useLayoutEffect, useMemo } from "react";
import type { RefObject } from "react";
import { parseTrackGenres } from "../../../lib/genres";
import type { LibraryIndex } from "../../../types";
import type { RouteState } from "../../../lib/routing";

interface UseLibrarySearchOptions {
  index: LibraryIndex;
  query: string;
  route: RouteState;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showSearchBar: boolean;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum: (artist: string, album: string) => void;
}

export function useLibrarySearch({
  index,
  query,
  route,
  search,
  onSearchChange,
  searchInputRef,
  showSearchBar,
  onOpenArtist,
  onOpenAlbum,
}: UseLibrarySearchOptions) {
  const normalizedQuery = query.trim().toLowerCase();

  useLayoutEffect(() => {
    if (!showSearchBar) return;
    const el = searchInputRef.current;
    if (!el) return;
    const hadFocus = document.activeElement === el;
    el.focus({ preventScroll: true });
    if (!search) {
      el.select();
    } else if (!hadFocus) {
      el.setSelectionRange(search.length, search.length);
    }
  }, [showSearchBar, searchInputRef, route.artist, route.album, search, normalizedQuery]);

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return null;
    const genreOk = (relPath: string) => {
      const tr = index.tracks.find((x) => x.relPath === relPath);
      return parseTrackGenres(tr?.meta?.genre).some((g) =>
        g.toLowerCase().includes(normalizedQuery)
      );
    };
    return {
      artists: index.artists.filter((item) => {
        if (item.name.toLowerCase().includes(normalizedQuery)) return true;
        return index.tracks.some(
          (tr) =>
            tr.artist === item.name &&
            parseTrackGenres(tr.meta?.genre).some((g) =>
              g.toLowerCase().includes(normalizedQuery)
            )
        );
      }),
      albums: index.albums.filter((item) => {
        if (
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.artist.toLowerCase().includes(normalizedQuery)
        ) {
          return true;
        }
        return item.tracks.some((rel) => genreOk(rel));
      }),
      tracks: index.tracks.filter(
        (item) =>
          item.title.toLowerCase().includes(normalizedQuery) ||
          item.artist.toLowerCase().includes(normalizedQuery) ||
          item.album.toLowerCase().includes(normalizedQuery) ||
          parseTrackGenres(item.meta?.genre).some((g) =>
            g.toLowerCase().includes(normalizedQuery)
          )
      ),
    };
  }, [index.albums, index.artists, index.tracks, normalizedQuery]);

  const openSearchArtist = (artistId: string) => {
    onSearchChange("");
    onOpenArtist(artistId);
  };

  const openSearchAlbum = (artistId: string, albumName: string) => {
    onSearchChange("");
    onOpenAlbum(artistId, albumName);
  };

  return {
    normalizedQuery,
    searchResults,
    openSearchArtist,
    openSearchAlbum,
  };
}
