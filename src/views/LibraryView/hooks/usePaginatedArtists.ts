import { useCallback, useEffect, useState } from "react";
import { fetchArtistsPage } from "../../../lib/api/library";
import type { LibraryArtistIndex } from "../../../types";

export function isPaginatedLibraryEnabled() {
  return import.meta.env.VITE_REKORD_PAGINATED_LIBRARY === "1";
}

export function usePaginatedArtists(opts: {
  sort?: "name" | "tracks";
  limit?: number;
  enabled?: boolean;
} = {}) {
  const enabled = opts.enabled ?? isPaginatedLibraryEnabled();
  const sort = opts.sort ?? "name";
  const limit = opts.limit ?? 50;
  const [artists, setArtists] = useState<LibraryArtistIndex[]>([]);
  const [offset, setOffset] = useState(0);
  const [indexEpoch, setIndexEpoch] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadPage = useCallback(
    async (nextOffset: number, replace = false) => {
      if (!enabled) return;
      setLoading(true);
      try {
        const page = await fetchArtistsPage({
          offset: nextOffset,
          limit,
          sort,
        });
        const rows = page.artists ?? [];
        setIndexEpoch(page.indexEpoch);
        setArtists((prev) => (replace ? rows : [...prev, ...rows]));
        setOffset(nextOffset + rows.length);
        setHasMore(rows.length >= limit);
      } finally {
        setLoading(false);
      }
    },
    [enabled, limit, sort],
  );

  useEffect(() => {
    if (!enabled) {
      setArtists([]);
      setOffset(0);
      setHasMore(true);
      return;
    }
    void loadPage(0, true);
  }, [enabled, loadPage, sort]);

  const loadMore = useCallback(() => {
    if (!enabled || loading || !hasMore) return;
    void loadPage(offset, false);
  }, [enabled, hasMore, loadPage, loading, offset]);

  return {
    artists,
    indexEpoch,
    loading,
    hasMore,
    loadMore,
    enabled,
  };
}
