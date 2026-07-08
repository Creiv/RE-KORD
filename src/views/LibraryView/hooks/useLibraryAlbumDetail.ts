import { useCallback, useMemo, useRef, useState } from "react";
import { useAppConfirm } from "../../../context/AppConfirmContext";
import {
  runWithLibrarySyncActivity,
  useLibrarySyncActivity,
} from "../../../context/LibrarySyncActivityContext";
import { useI18n } from "../../../i18n/useI18n";
import {
  usePopoverLayerAnchored,
  type PopoverLayerOptions,
} from "../../../hooks/usePopoverLayerAnchored";
import { saveTrackInfoManual, uploadAlbumCover } from "../../../lib/api";
import {
  parseTrackGenres,
  serializeTrackGenres,
} from "../../../lib/genres";
import type {
  LibraryAlbumIndex,
  LibraryEntityDelta,
  LibraryIndex,
  LibraryTrackIndex,
} from "../../../types";

/** Stima `min-width` lista generi (16rem + margine) per il flip orizzontale sotto il +. */
const ALBUM_GENRE_POPOVER_PLACEMENT_OPTS: PopoverLayerOptions = {
  alignMinWidthPx: 268,
  edgeMarginPx: 8,
};

interface UseLibraryAlbumDetailOptions {
  album: LibraryAlbumIndex | null;
  albumTracks: LibraryTrackIndex[];
  index: LibraryIndex;
  onLibraryDelta?: (delta: LibraryEntityDelta, reconcile?: boolean) => void;
  onReconcileLibrary: (
    opts?: import("../../../lib/libraryReconcile").LibraryReconcileOptions
  ) => Promise<void>;
}

export function useLibraryAlbumDetail({
  album,
  albumTracks,
  index,
  onLibraryDelta,
  onReconcileLibrary,
}: UseLibraryAlbumDetailOptions) {
  const librarySync = useLibrarySyncActivity();
  const { t, sortLocale } = useI18n();
  const { confirm: appConfirm } = useAppConfirm();

  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const [coverUploadBusy, setCoverUploadBusy] = useState(false);
  const [coverUploadErr, setCoverUploadErr] = useState<string | null>(null);

  const [albumGenrePickerOpen, setAlbumGenrePickerOpen] = useState(false);
  const [albumGenreBusy, setAlbumGenreBusy] = useState(false);
  const [albumGenreErr, setAlbumGenreErr] = useState<string | null>(null);
  const albumGenreAnchorRef = useRef<HTMLDivElement | null>(null);
  const albumGenreMenuRef = useRef<HTMLUListElement | null>(null);
  const closeAlbumGenrePicker = useCallback(
    () => setAlbumGenrePickerOpen(false),
    []
  );
  const albumGenrePlacement = usePopoverLayerAnchored(
    albumGenrePickerOpen,
    albumGenreAnchorRef,
    closeAlbumGenrePicker,
    albumGenreMenuRef,
    ALBUM_GENRE_POPOVER_PLACEMENT_OPTS
  );

  const onCoverFilePicked = (file: File | null) => {
    if (!file || !album || coverUploadBusy) return;
    setCoverUploadBusy(true);
    setCoverUploadErr(null);
    uploadAlbumCover(album.relPath, file)
      .then((delta) => {
        onLibraryDelta?.(delta, false);
      })
      .catch((e) => {
        setCoverUploadErr(String(e?.message || e));
      })
      .finally(() => setCoverUploadBusy(false));
  };

  const albumTrackGenres = useMemo(() => {
    const byLower = new Map<string, string>();
    for (const tr of albumTracks) {
      for (const g of parseTrackGenres(tr.meta?.genre)) {
        const low = g.toLowerCase();
        if (!byLower.has(low)) byLower.set(low, g);
      }
    }
    return Array.from(byLower.values()).sort((a, b) =>
      a.localeCompare(b, sortLocale, { numeric: true })
    );
  }, [albumTracks, sortLocale]);

  const albumTrackGenreCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tr of albumTracks) {
      for (const g of parseTrackGenres(tr.meta?.genre)) {
        const low = g.toLowerCase();
        counts.set(low, (counts.get(low) ?? 0) + 1);
      }
    }
    return counts;
  }, [albumTracks]);

  const applyAlbumGenreToAllTracks = useCallback(
    async (
      genreToken: string,
      applyMode: "add" | "remove",
      targetTracks = albumTracks
    ) => {
      const albumPath = album?.relPath;
      if (!albumPath || targetTracks.length === 0) return;
      const token = genreToken.trim();
      if (!token) return;
      const low = token.toLowerCase();
      setAlbumGenreBusy(true);
      setAlbumGenreErr(null);
      try {
        await runWithLibrarySyncActivity(
          librarySync.beginActivity,
          "sync.activity.updatingGenres",
          async () => {
            const trackPatches: NonNullable<LibraryEntityDelta["tracks"]> = [];
            for (const tr of targetTracks) {
              const cur = parseTrackGenres(tr.meta?.genre);
              const hasGenre = cur.some((g) => g.toLowerCase() === low);
              if (applyMode === "add" && hasGenre) continue;
              if (applyMode === "remove" && !hasGenre) continue;
              const next =
                applyMode === "add"
                  ? [...cur, token]
                  : cur.filter((g) => g.toLowerCase() !== low);
              const nextSerialized = serializeTrackGenres(next);
              const saved = await saveTrackInfoManual(tr.relPath, {
                genre: nextSerialized || null,
              });
              if (saved.track) trackPatches.push(saved.track);
            }
            if (trackPatches.length && onLibraryDelta) {
              onLibraryDelta({ tracks: trackPatches }, false);
            }
            if (trackPatches.length) {
              await onReconcileLibrary({ mode: "now" });
            } else if (!onLibraryDelta) {
              await onReconcileLibrary({ mode: "debounced" });
            }
          }
        );
      } catch (e: unknown) {
        setAlbumGenreErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAlbumGenreBusy(false);
      }
    },
    [album?.relPath, albumTracks, librarySync, onLibraryDelta, onReconcileLibrary]
  );

  const albumGenreOptions = useMemo(() => {
    const albumKeys = new Set(albumTrackGenres.map((g) => g.toLowerCase()));
    const byLower = new Map<string, string>();
    for (const tr of index.tracks) {
      for (const g of parseTrackGenres(tr.meta?.genre)) {
        const low = g.toLowerCase();
        if (!byLower.has(low)) byLower.set(low, g);
      }
    }
    return Array.from(byLower.values())
      .filter((g) => !albumKeys.has(g.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, sortLocale, { numeric: true }));
  }, [albumTrackGenres, index.tracks, sortLocale]);

  const addAlbumGenreBySelection = useCallback(
    async (genreToken: string) => {
      const token = genreToken.trim();
      if (!token) return;
      await applyAlbumGenreToAllTracks(token, "add");
      setAlbumGenrePickerOpen(false);
    },
    [applyAlbumGenreToAllTracks]
  );

  const applyAlbumGenreToMissingTracks = useCallback(
    async (genreToken: string) => {
      const token = genreToken.trim();
      if (!token) return;
      const low = token.toLowerCase();
      const missingTracks = albumTracks.filter(
        (tr) =>
          !parseTrackGenres(tr.meta?.genre).some((g) => g.toLowerCase() === low)
      );
      if (missingTracks.length === 0) return;
      if (
        !(await appConfirm({
          message: t("albumMeta.addGenreMissingConfirm", {
            g: genreToken,
            n: missingTracks.length,
          }),
        }))
      ) {
        return;
      }
      await applyAlbumGenreToAllTracks(token, "add", missingTracks);
    },
    [albumTracks, appConfirm, applyAlbumGenreToAllTracks, t]
  );

  const removeAlbumGenre = useCallback(
    async (genreToken: string) => {
      if (
        !(await appConfirm({
          message: t("albumMeta.removeGenreAllConfirm", { g: genreToken }),
          variant: "danger",
        }))
      ) {
        return;
      }
      await applyAlbumGenreToAllTracks(genreToken, "remove");
    },
    [appConfirm, applyAlbumGenreToAllTracks, t]
  );

  return {
    coverFileInputRef,
    coverUploadBusy,
    coverUploadErr,
    onCoverFilePicked,
    albumGenrePickerOpen,
    setAlbumGenrePickerOpen,
    albumGenreBusy,
    albumGenreErr,
    albumGenreAnchorRef,
    albumGenreMenuRef,
    albumGenrePlacement,
    albumTrackGenres,
    albumTrackGenreCounts,
    albumGenreOptions,
    addAlbumGenreBySelection,
    applyAlbumGenreToMissingTracks,
    removeAlbumGenre,
  };
}
