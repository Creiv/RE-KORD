import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, RefObject } from "react";
import { usePlayer } from "../../context/PlayerContext";
import { useRhythmMode } from "../../context/RhythmModeContext";
import {
  emitStudioPane,
  StudioNavigationProvider,
} from "../../context/StudioNavigationContext";
import { useLibrarySyncActivity } from "../../context/LibrarySyncActivityContext";
import { useToolsActivity } from "../../context/ToolsActivityContext";
import { useUserState } from "../../context/UserStateContext";
import { useMatchMedia } from "../../hooks/useMatchMedia";
import { usePlayerDockCssVars } from "../../hooks/usePlayerDockCssVars";
import { useViewportHeight } from "../../hooks/useViewportHeight";
import { useSyncStatusSnackbar } from "../../hooks/useSyncStatusSnackbar";
import { MOBILE_LAYOUT_MQ } from "../../lib/breakpoints";
import {
  openArtistInLibrary,
  openTrackInLibrary,
  resolveTrackFromLibrary,
} from "../../lib/libraryNav";
import { useI18n } from "../../i18n/useI18n";
import {
  fetchDashboard,
  fetchLibraryChanges,
  fetchLibraryIndex,
  isBackendUnreachableError,
} from "../../lib/api";
import { clientLegacyLibrary } from "../../lib/libraryIndex";
import {
  applyLibraryDeltaToIndex,
  applyLibraryDeltasToIndex,
  libraryDeltaTouchesCover,
  mergeLibraryIndexFromServer,
  libraryIndexRehydrateSig,
} from "../../lib/libraryIndex";
import { syncLibraryAlbumArtworkFromIndex } from "../../lib/libraryArtworkStore";
import type { LibraryReconcileOptions } from "../../lib/libraryReconcile";
import { parseTrackGenres } from "../../lib/genres";
import { useAppRoute } from "../../lib/routing";
import { RekordSplashLoader } from "../RekordSplashLoader";
import { RekordViewLoadingFallback } from "../RekordViewLoadingFallback";
import { PlayerDock } from "../PlayerDock/PlayerDock";
import { MobileBottomNav } from "../MobileBottomNav/MobileBottomNav";
import { SideBar } from "./SideBar/SideBar";
import { SyncStatusSnackbar } from "./SyncStatusSnackbar";
import { TopBar } from "./TopBar/TopBar";
import {
  AlbumMetaEditProvider,
} from "../AlbumMetaEditor";
import { LibraryArtworkProvider } from "../../context/LibraryArtworkContext";
import {
  TrackMetaEditProvider,
} from "../TrackMetaEditor";
import {
  UiFavorite,
  UiHistory,
} from "../RekordUiIcons";
import type {
  AppSection,
  DashboardPayload,
  LibraryEntityDelta,
  LibraryIndex,
  LibraryTrackIndex,
} from "../../types";
import styles from "./AppShell.module.css";

const LazyDashboardView = lazy(() => import("../../views/DashboardView/DashboardView"));
const LazyLibraryView = lazy(() => import("../../views/LibraryView/LibraryView"));
const LazyQueueViewNew = lazy(() => import("../../views/QueueViewNew"));
const LazyPlaylistsViewNew = lazy(() => import("../../views/PlaylistsViewNew"));
const LazyTrackCollectionView = lazy(() => import("../../views/TrackCollectionView"));
const LazyStatisticsView = lazy(() => import("../../views/StatisticsView"));
const LazyAchievementsView = lazy(
  () => import("../../views/AchievementsView/AchievementsView")
);
const LazySettingsView = lazy(() => import("../../views/SettingsView"));
const LazyToolsView = lazy(() =>
  import("../ToolsView").then((m) => ({ default: m.ToolsView }))
);
/** Dopo modifiche ai metadati il server ricostruisce l'indice; evitiamo tsunami di GET /library-index. */
const LIBRARY_RECONCILE_DEBOUNCE_MS = 1400;

export function AppShell() {
  const { route, navigate } = useAppRoute();
  const p = usePlayer();
  const { setOpen: setRhythmOpen } = useRhythmMode();
  usePlayerDockCssVars(p.queue.length);
  useViewportHeight();
  const isMobileLayout = useMatchMedia(MOBILE_LAYOUT_MQ);
  const user = useUserState();
  const syncUserStateFromServer = user.syncUserStateFromServer;
  const {
    beginActivity: beginLibrarySyncActivity,
    busy: librarySyncBusy,
    primaryActivity: librarySyncPrimaryActivity,
  } = useLibrarySyncActivity();
  const { t } = useI18n();
  const formatLoadError = useCallback(
    (message: string | null) => {
      if (!message) return null;
      const electronClient =
        typeof document !== "undefined" &&
        document.documentElement.dataset.rekordClient === "1";
      if (message === "errors.backendUnreachable") {
        return t(
          electronClient
            ? "errors.backendUnreachableElectron"
            : "errors.backendUnreachable",
        );
      }
      if (isBackendUnreachableError(message)) {
        return t(
          electronClient
            ? "errors.backendUnreachableElectron"
            : "errors.backendUnreachable",
        );
      }
      return message;
    },
    [t]
  );
  const toolsActivity = useToolsActivity();

  const [index, setIndex] = useState<LibraryIndex | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [librarySearchBarOpen, setLibrarySearchBarOpen] = useState(false);
  const [libraryHomeTick, setLibraryHomeTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null) as RefObject<HTMLInputElement | null>;
  const prevSectionForSearchRef = useRef<AppSection | null>(null);
  const syncTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSeqRef = useRef(0);
  const indexRef = useRef<LibraryIndex | null>(null);
  const indexLibrarySigRef = useRef("");
  const backgroundRefreshRef = useRef<Promise<void> | null>(null);
  const libraryRefreshQueuedAfterFlightRef = useRef(false);
  const indexEpochRef = useRef(0);
  const libraryReconcileDebounceRef = useRef<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);
  const [syncTapAnim, setSyncTapAnim] = useState(false);

  const refreshLibrary = useCallback(
    (mode: "manual" | "background" = "manual", syncUser = false) => {
      const seq = ++refreshSeqRef.current;
      const endActivity = beginLibrarySyncActivity(
        mode === "manual"
          ? "sync.activity.reloadLibrary"
          : "sync.activity.refreshIndex"
      );
      const blockUi = mode === "manual" && !indexRef.current;
      if (blockUi) setLoading(true);
      const task = Promise.all([fetchLibraryIndex(), fetchDashboard()])
        .then(async ([libraryData, dashboardData]) => {
          if (seq !== refreshSeqRef.current) return;
          setIndex((prev) => {
            const next = mergeLibraryIndexFromServer(prev, libraryData);
            syncLibraryAlbumArtworkFromIndex(next);
            return next;
          });
          setDashboard(dashboardData);
          setError(null);
          if (mode === "manual" && syncUser) await syncUserStateFromServer();
        })
        .catch((err: unknown) => {
          if (seq !== refreshSeqRef.current) return;
          setError(
            isBackendUnreachableError(err)
              ? "errors.backendUnreachable"
              : String(err)
          );
        })
        .finally(() => {
          endActivity();
          if (blockUi) setLoading(false);
        });
      return task;
    },
    [beginLibrarySyncActivity, syncUserStateFromServer]
  );

  const runCoalescedBackgroundRefresh = useCallback(() => {
    if (backgroundRefreshRef.current) {
      libraryRefreshQueuedAfterFlightRef.current = true;
      return backgroundRefreshRef.current;
    }
    libraryRefreshQueuedAfterFlightRef.current = false;
    const task = (async () => {
      await refreshLibrary("background");
      while (libraryRefreshQueuedAfterFlightRef.current) {
        libraryRefreshQueuedAfterFlightRef.current = false;
        await refreshLibrary("background");
      }
    })();
    backgroundRefreshRef.current = task;
    void task.finally(() => {
      if (backgroundRefreshRef.current !== task) return;
      backgroundRefreshRef.current = null;
    });
    return task;
  }, [refreshLibrary]);

  const scheduleDebouncedLibraryReconcile = useCallback(() => {
    if (libraryReconcileDebounceRef.current != null) {
      globalThis.clearTimeout(libraryReconcileDebounceRef.current);
    }
    libraryReconcileDebounceRef.current = globalThis.setTimeout(() => {
      libraryReconcileDebounceRef.current = null;
      void runCoalescedBackgroundRefresh();
    }, LIBRARY_RECONCILE_DEBOUNCE_MS);
  }, [runCoalescedBackgroundRefresh]);

  const refreshManual = useCallback(
    (syncUser = false) => {
      if (libraryReconcileDebounceRef.current != null) {
        globalThis.clearTimeout(libraryReconcileDebounceRef.current);
        libraryReconcileDebounceRef.current = null;
      }
      libraryRefreshQueuedAfterFlightRef.current = false;
      return refreshLibrary("manual", syncUser);
    },
    [refreshLibrary]
  );

  /** Refresh indice in background, accodato e debounced (studio / metadati rapidi). */
  const refreshBackground = useCallback((): Promise<void> => {
    scheduleDebouncedLibraryReconcile();
    return Promise.resolve();
  }, [scheduleDebouncedLibraryReconcile]);

  /** Dopo download o scan massivi: refresh subito, una richiesta alla volta. */
  const refreshLibraryNow = useCallback(() => {
    if (libraryReconcileDebounceRef.current != null) {
      globalThis.clearTimeout(libraryReconcileDebounceRef.current);
      libraryReconcileDebounceRef.current = null;
    }
    return runCoalescedBackgroundRefresh();
  }, [runCoalescedBackgroundRefresh]);

  /**
   * Unico ingresso per riconciliare indice libreria + dashboard.
   * @see src/lib/libraryReconcile.ts
   */
  const reconcileLibrary = useCallback(
    (opts?: LibraryReconcileOptions): Promise<void> => {
      const mode = opts?.mode ?? "debounced";
      if (mode === "manual") {
        return refreshManual(Boolean(opts?.syncUser));
      }
      if (mode === "now") {
        return refreshLibraryNow();
      }
      return refreshBackground();
    },
    [refreshBackground, refreshLibraryNow, refreshManual]
  );

  const applyLibraryDelta = useCallback(
    (delta: LibraryEntityDelta, reconcile = true) => {
      const endActivity = beginLibrarySyncActivity(
        "sync.activity.updatingLibrary"
      );
      setIndex((prev) => {
        const next = applyLibraryDeltaToIndex(prev, delta);
        if (next) {
          syncLibraryAlbumArtworkFromIndex(next);
          queueMicrotask(() => p.resyncTracksFromIndex(next));
        }
        return next;
      });
      endActivity();
      if (libraryDeltaTouchesCover(delta)) p.syncMediaSessionNow();
      if (reconcile) scheduleDebouncedLibraryReconcile();
    },
    [beginLibrarySyncActivity, p, scheduleDebouncedLibraryReconcile]
  );

  const applyLibraryDeltas = useCallback(
    (deltas: LibraryEntityDelta[], reconcile = false) => {
      if (!deltas.length) return;
      const endActivity = beginLibrarySyncActivity(
        "sync.activity.updatingLibrary"
      );
      setIndex((prev) => {
        const next = applyLibraryDeltasToIndex(prev, deltas);
        if (next) syncLibraryAlbumArtworkFromIndex(next);
        return next;
      });
      endActivity();
      if (deltas.some(libraryDeltaTouchesCover)) p.syncMediaSessionNow();
      if (reconcile) scheduleDebouncedLibraryReconcile();
    },
    [beginLibrarySyncActivity, p, scheduleDebouncedLibraryReconcile]
  );

  const refreshAfterAlbumMetaSaved = useCallback(
    (delta?: LibraryEntityDelta) => {
      if (delta) {
        applyLibraryDelta(delta, false);
        return;
      }
      void reconcileLibrary({ mode: "debounced" });
    },
    [applyLibraryDelta, reconcileLibrary]
  );

  const refreshAfterTrackMetaSaved = useCallback(
    (delta?: LibraryEntityDelta) => {
      if (delta) {
        applyLibraryDelta(delta, false);
        return;
      }
      void reconcileLibrary({ mode: "debounced" });
    },
    [applyLibraryDelta, reconcileLibrary]
  );

  const bootstrapLoading = loading && !index;

  const syncBusy =
    bootstrapLoading ||
    librarySyncBusy ||
    toolsActivity.toolsAnyBusy;

  const syncStatusTitle = useMemo(() => {
    const primary = librarySyncPrimaryActivity;
    if (primary) {
      return t(
        primary.labelKey as Parameters<typeof t>[0],
        primary.labelParams
      );
    }
    if (bootstrapLoading) return t("sync.activity.reloadLibrary");
    if (toolsActivity.toolsAnyBusy) return t("topbar.toolsBusyTitle");
    return t("topbar.refreshTitle");
  }, [librarySyncPrimaryActivity, bootstrapLoading, t, toolsActivity.toolsAnyBusy]);

  const { open: syncSnackbarOpen } = useSyncStatusSnackbar(syncBusy);

  const onSyncButtonClick = useCallback(() => {
    setSyncTapAnim(true);
    if (syncTapTimerRef.current) clearTimeout(syncTapTimerRef.current);
    syncTapTimerRef.current = setTimeout(() => {
      setSyncTapAnim(false);
      syncTapTimerRef.current = null;
    }, 500);
    void reconcileLibrary({ mode: "manual", syncUser: true });
  }, [reconcileLibrary]);

  useEffect(
    () => () => {
      if (syncTapTimerRef.current) clearTimeout(syncTapTimerRef.current);
      if (libraryReconcileDebounceRef.current != null) {
        globalThis.clearTimeout(libraryReconcileDebounceRef.current);
      }
    },
    []
  );

  useLayoutEffect(() => {
    document.documentElement.dataset.playerDock =
      p.queue.length > 0 ? "1" : "0";
  }, [p.queue.length]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reconcileLibrary({ mode: "manual" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reconcileLibrary]);

  useEffect(() => {
    if (index?.indexEpoch != null) {
      indexEpochRef.current = index.indexEpoch;
    }
  }, [index?.indexEpoch]);

  useEffect(() => {
    if (!index) return;
    const pollMs = 4000;
    const timer = window.setInterval(() => {
      void fetchLibraryChanges(indexEpochRef.current)
        .then((snap) => {
          indexEpochRef.current = snap.indexEpoch;
          if (snap.changed && !snap.scanning) {
            void runCoalescedBackgroundRefresh();
          }
        })
        .catch(() => {
          /* server offline */
        });
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [index, runCoalescedBackgroundRefresh]);

  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const prefetch = () => {
      void import("../../views/DashboardView/DashboardView");
      void import("../../views/ListenView/ListenView");
      void import("../../views/LibraryView/LibraryView");
    };
    const id =
      typeof w.requestIdleCallback === "function"
        ? w.requestIdleCallback(prefetch, { timeout: 2000 })
        : window.setTimeout(prefetch, 900);
    return () => {
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
      else window.clearTimeout(id as unknown as number);
    };
  }, []);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    if (!index || !user.ready) return;
    p.resyncTracksFromIndex(index);
    user.rehydrateTrackListsFromLibrary(index);
    const sig = libraryIndexRehydrateSig(index);
    if (sig === indexLibrarySigRef.current) return;
    indexLibrarySigRef.current = sig;
    user.rehydrateShuffleExclusionsFromIndex(index);
  }, [
    index,
    p.resyncTracksFromIndex,
    user.ready,
    user.rehydrateTrackListsFromLibrary,
    user.rehydrateShuffleExclusionsFromIndex,
  ]);

  useEffect(() => {
    const prev = prevSectionForSearchRef.current;
    if (prev === "libreria" && route.section !== "libreria") {
      const id = window.requestAnimationFrame(() => {
        setSearch("");
        setLibrarySearchBarOpen(false);
      });
      prevSectionForSearchRef.current = route.section;
      return () => window.cancelAnimationFrame(id);
    }
    prevSectionForSearchRef.current = route.section;
  }, [route.section]);

  const closeLibrarySearch = useCallback(() => {
    setSearch("");
    setLibrarySearchBarOpen(false);
  }, []);

  /** Home libreria senza artista/album; resetta anche filtri overview (tick). */
  const goLibraryRootForBrowse = useCallback(() => {
    if (route.section !== "libreria") {
      setLibraryHomeTick((n) => n + 1);
      navigate({ section: "libreria", artist: null, album: null });
      return;
    }
    if (route.artist != null || route.album != null) {
      setLibraryHomeTick((n) => n + 1);
      navigate({ section: "libreria", artist: null, album: null });
    }
  }, [navigate, route.section, route.artist, route.album]);

  const focusLibrarySearchInput = useCallback(() => {
    const el = searchInputRef.current;
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.select();
    return true;
  }, []);

  const openLibrarySearch = useCallback(() => {
    setLibrarySearchBarOpen(true);
    goLibraryRootForBrowse();
  }, [goLibraryRootForBrowse]);

  const toggleLibrarySearchBar = useCallback(() => {
    if (librarySearchBarOpen) {
      closeLibrarySearch();
    } else {
      openLibrarySearch();
    }
  }, [librarySearchBarOpen, closeLibrarySearch, openLibrarySearch]);

  useLayoutEffect(() => {
    if (!librarySearchBarOpen || route.section !== "libreria") return;
    if (focusLibrarySearchInput()) return;
    const id = window.setTimeout(() => {
      focusLibrarySearchInput();
    }, 0);
    return () => window.clearTimeout(id);
  }, [
    librarySearchBarOpen,
    route.section,
    route.artist,
    route.album,
    libraryHomeTick,
    focusLibrarySearchInput,
  ]);

  const legacyLibrary = useMemo(() => {
    if (!index || route.section !== "studio") return null;
    return clientLegacyLibrary(index);
  }, [index, route.section]);

  const favoriteTracks = useMemo(() => {
    if (!index || route.section !== "favorites") return [];
    return user.state.favorites
      .map((relPath) => index.tracks.find((track) => track.relPath === relPath))
      .filter((track): track is LibraryTrackIndex => Boolean(track))
      .sort(
        (a, b) =>
          (user.state.trackPlayCounts?.[b.relPath] ?? 0) -
            (user.state.trackPlayCounts?.[a.relPath] ?? 0) ||
          a.title.localeCompare(b.title, undefined, { numeric: true })
      );
  }, [index, route.section, user.state.favorites, user.state.trackPlayCounts]);

  const [libraryGenreOptions, setLibraryGenreOptions] = useState<
    readonly string[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    if (!index) {
      const clearId = window.setTimeout(() => {
        if (!cancelled) setLibraryGenreOptions([]);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(clearId);
      };
    }
    const compute = () => {
      const s = new Set<string>();
      for (const tr of index.tracks) {
        for (const g of parseTrackGenres(tr.meta?.genre)) s.add(g);
      }
      const next = [...s].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
      if (!cancelled) setLibraryGenreOptions(next);
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleId =
      typeof w.requestIdleCallback === "function"
        ? w.requestIdleCallback(compute, { timeout: 1500 })
        : window.setTimeout(compute, 0);
    return () => {
      cancelled = true;
      if (typeof w.cancelIdleCallback === "function" && typeof idleId === "number") {
        w.cancelIdleCallback(idleId);
      } else {
        window.clearTimeout(idleId as unknown as number);
      }
    };
  }, [index]);

  useEffect(() => {
    if (route.section !== "gioco") return;
    if (p.queue.length > 0) setRhythmOpen(true);
    startTransition(() => navigate({ section: "dashboard" }));
  }, [navigate, p.queue.length, route.section, setRhythmOpen]);

  const navToSection = useCallback(
    (section: AppSection) => navigate({ section }),
    [navigate]
  );
  const navToLibraryArtist = useCallback(
    (artist: string) => {
      closeLibrarySearch();
      navigate({ section: "libreria", artist: artist || null, album: null });
    },
    [navigate, closeLibrarySearch]
  );
  const navToLibraryAlbum = useCallback(
    (artist: string, album: string) => {
      closeLibrarySearch();
      navigate({ section: "libreria", artist, album });
    },
    [navigate, closeLibrarySearch]
  );
  const smartNavToLibraryArtist = useCallback(
    (artistId: string) => {
      if (!index) {
        navToLibraryArtist(artistId);
        return;
      }
      openArtistInLibrary(
        index,
        artistId,
        navToLibraryArtist,
        navToLibraryAlbum,
      );
    },
    [index, navToLibraryArtist, navToLibraryAlbum],
  );
  const smartNavToLibraryForTrack = useCallback(
    (track: import("../../types").EnrichedTrack) => {
      if (!index) {
        navToLibraryAlbum(track.artist, track.album);
        return;
      }
      openTrackInLibrary(
        index,
        track,
        navToLibraryArtist,
        navToLibraryAlbum,
      );
    },
    [index, navToLibraryArtist, navToLibraryAlbum],
  );
  const resolvePlaybackTrack = useCallback(
    (track: import("../../types").EnrichedTrack) =>
      index
        ? resolveTrackFromLibrary(track, index.tracks)
        : track,
    [index],
  );
  const navToPlaylist = useCallback(
    (id: string | null) => navigate({ section: "playlists", playlist: id }),
    [navigate]
  );
  const openStudioListen = useCallback(() => {
    emitStudioPane("listen");
    startTransition(() => navigate({ section: "studio" }));
  }, [navigate]);

  const onGoToAscolta = openStudioListen;

  const goAppSection = useCallback(
    (section: AppSection) => {
      if (section === "ascolta") {
        openStudioListen();
        return;
      }
      if (section === "gioco") {
        if (p.queue.length > 0) setRhythmOpen(true);
        startTransition(() => navigate({ section: "dashboard" }));
        return;
      }
      if (section === "libreria") {
        closeLibrarySearch();
        setLibraryHomeTick((n) => n + 1);
      }
      startTransition(() => {
        navigate({ section });
      });
    },
    [closeLibrarySearch, navigate, openStudioListen, p.queue.length, setRhythmOpen],
  );

  useEffect(() => {
    const raw = window.location.pathname.replace(/^\/+/, "").split("/")[0];
    if (raw !== "ascolta") return;
    openStudioListen();
  }, [openStudioListen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      /* Scorciatoie globali solo su desktop: su mobile interferiscono con
         scroll, tastiera virtuale e touch. */
      if (window.matchMedia(MOBILE_LAYOUT_MQ).matches) return;

      const target = event.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;

      if (event.ctrlKey && event.key.toLowerCase() === "k" && !event.altKey) {
        event.preventDefault();
        openLibrarySearch();
        return;
      }

      if (inField) return;

      if (event.key === "/" && !event.altKey) {
        event.preventDefault();
        openLibrarySearch();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        p.toggle();
      } else if (event.code === "KeyI") {
        event.preventDefault();
        openStudioListen();
      } else if (event.code === "KeyP") {
        event.preventDefault();
        if (p.queue.length > 0) setRhythmOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openLibrarySearch, openStudioListen, p, setRhythmOpen]);

  const onLibraryHome = useCallback(() => {
    closeLibrarySearch();
    setLibraryHomeTick((n) => n + 1);
    navigate({ section: "libreria" });
  }, [navigate, closeLibrarySearch]);

  const currentView = (() => {
    if (route.section === "settings") {
      return (
        <Suspense fallback={<RekordViewLoadingFallback />}>
          <LazySettingsView />
        </Suspense>
      );
    }
    if (bootstrapLoading) return <RekordSplashLoader />;
    if (error && !index)
      return (
        <div className="panel-empty danger">{formatLoadError(error)}</div>
      );
    if (!index) return <div className="panel-empty">{t("empty.noData")}</div>;
    switch (route.section) {
      case "dashboard":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyDashboardView
              dashboard={dashboard}
              index={index}
              onOpenAlbum={navToLibraryAlbum}
              onOpenSection={navToSection}
            />
          </Suspense>
        );
      case "libreria":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyLibraryView
              index={index}
              route={route}
              query={deferredSearch}
              libraryHomeTick={libraryHomeTick}
              search={search}
              onSearchChange={setSearch}
              searchInputRef={searchInputRef}
              showSearchBar={librarySearchBarOpen}
              onSearchBarClose={closeLibrarySearch}
              onReconcileLibrary={reconcileLibrary}
              onLibraryDelta={(delta, reconcile) =>
                applyLibraryDelta(delta, reconcile ?? false)
              }
              onOpenArtist={smartNavToLibraryArtist}
              onOpenAlbum={navToLibraryAlbum}
            />
          </Suspense>
        );
      case "studio":
        return (
          <div className="view-page view-page--studio">
            <Suspense fallback={<RekordViewLoadingFallback />}>
              <LazyToolsView
                library={legacyLibrary}
                libraryIndex={index}
                onReconcileLibrary={reconcileLibrary}
                onLibraryDelta={applyLibraryDelta}
                onLibraryDeltas={applyLibraryDeltas}
                onOpenSection={navToSection}
              />
            </Suspense>
          </div>
        );
      case "queue":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyQueueViewNew
              onOpenSavedPlaylist={navToPlaylist}
            />
          </Suspense>
        );
      case "playlists":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyPlaylistsViewNew
              route={route}
              index={index}
              onPickPlaylist={navToPlaylist}
            />
          </Suspense>
        );
      case "favorites":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyTrackCollectionView
              title={t("collection.favoritesTitle")}
              eyebrow={t("collection.favoritesEyebrow")}
              leadIcon={<UiFavorite className="section-head__ic" />}
              tracks={favoriteTracks}
              libraryTracks={index.tracks}
              collectionMode="shuffle"
            />
          </Suspense>
        );
      case "recent":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyTrackCollectionView
              title={t("collection.recentTitle")}
              eyebrow={t("collection.recentEyebrow")}
              leadIcon={<UiHistory className="section-head__ic" />}
              tracks={user.state.recent}
              libraryTracks={index.tracks}
              collectionMode="radio"
            />
          </Suspense>
        );
      case "statistics":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyStatisticsView
              index={index}
              onOpenArtist={smartNavToLibraryArtist}
              onOpenAlbum={navToLibraryAlbum}
            />
          </Suspense>
        );
      case "achievements":
        return (
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazyAchievementsView
              index={index}
              onOpenSection={navToSection}
            />
          </Suspense>
        );
      default:
        return null;
    }
  })();

  const sideW = isMobileLayout ? "0px" : "56px";

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--side-w", sideW);
  }, [sideW]);

  return (
    <StudioNavigationProvider openStudioListen={openStudioListen}>
    <LibraryArtworkProvider index={index}>
    <TrackMetaEditProvider
      genreOptions={libraryGenreOptions}
      onSaved={refreshAfterTrackMetaSaved}
    >
      <AlbumMetaEditProvider onSaved={refreshAfterAlbumMetaSaved}>
        <div
          className={styles.shell}
          style={{ "--side-w": sideW } as CSSProperties}
        >
          <div className={styles.body}>
            <div className="shell__workspace">
            {/* Desktop sidebar nav */}
            {!isMobileLayout ? (
              <SideBar
                activeSection={route.section}
                onNavigate={navToSection}
                onLibraryHome={onLibraryHome}
                index={index}
              />
            ) : null}

            <div className={`${styles.main} shell__main`}>
              {/* Mobile topbar */}
              <TopBar
                activeSection={route.section}
                syncBusy={syncBusy}
                syncStatusTitle={syncStatusTitle}
                syncTapAnim={syncTapAnim}
                librarySearchBarOpen={librarySearchBarOpen}
                onSync={onSyncButtonClick}
                onToggleSearch={toggleLibrarySearchBar}
              />

              {error && index ? (
                <div className={styles.banner}>{formatLoadError(error)}</div>
              ) : null}
              {user.error ? (
                <div className={styles.banner}>
                  {user.error === "errors.backendUnreachable"
                    ? formatLoadError(user.error)
                    : `${t("persist.banner")} ${formatLoadError(user.error)}`}
                </div>
              ) : null}

              <main className={`content-shell ${styles.content}`}>
                <div className="content-shell__inner" key={route.section}>
                  {currentView}
                </div>
              </main>
            </div>
            </div>
          </div>

          <PlayerDock
            onGoToAscolta={onGoToAscolta}
            onOpenLibraryArtist={smartNavToLibraryArtist}
            onOpenLibraryAlbum={navToLibraryAlbum}
            onOpenLibraryForTrack={smartNavToLibraryForTrack}
            resolvePlaybackTrack={resolvePlaybackTrack}
            onLibraryDelta={applyLibraryDelta}
          />
          {isMobileLayout ? (
            <MobileBottomNav active={route.section} onSelect={goAppSection} />
          ) : null}
          {syncSnackbarOpen ? (
            <SyncStatusSnackbar
              message={syncStatusTitle}
              busy={syncBusy}
            />
          ) : null}
        </div>
      </AlbumMetaEditProvider>
    </TrackMetaEditProvider>
    </LibraryArtworkProvider>
    </StudioNavigationProvider>
  );
}
