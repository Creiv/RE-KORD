import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { parseTrackGenres } from "../../../lib/genres";
import { buildLibraryTrackLookup, lookupLibraryTrack } from "../../../lib/libraryNav";
import { searchLibrary } from "../../../lib/api/library";
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
  enabled?: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;

function clientSearchResults(index: LibraryIndex, normalizedQuery: string) {
  const trackLookup = buildLibraryTrackLookup(index.tracks);
  const genreOk = (relPath: string) => {
    const tr = lookupLibraryTrack(trackLookup, { relPath });
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
  enabled = true,
}: UseLibrarySearchOptions) {
  const normalizedQuery = enabled ? query.trim().toLowerCase() : "";
  const [serverResults, setServerResults] = useState<ReturnType<
    typeof clientSearchResults
  > | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    if (!enabled || !normalizedQuery) {
      setServerResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void searchLibrary(normalizedQuery, ac.signal)
        .then((results) => {
          if (ac.signal.aborted) return;
          setServerResults(results);
        })
        .catch(() => {
          if (ac.signal.aborted) return;
          setServerResults(clientSearchResults(index, normalizedQuery));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [enabled, index, normalizedQuery]);

  const searchResults = useMemo(() => {
    if (!enabled || !normalizedQuery) return null;
    return serverResults ?? clientSearchResults(index, normalizedQuery);
  }, [enabled, index, normalizedQuery, serverResults]);

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
