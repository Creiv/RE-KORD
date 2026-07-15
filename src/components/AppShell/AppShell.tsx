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
import { readPlayerProgressTime } from "../../context/playerProgressStore";
import { usePlayer } from "../../context/PlayerContext";
import { useRhythmMode } from "../../context/RhythmModeContext";
import {
  emitStudioPane,
  StudioNavigationProvider,
} from "../../context/StudioNavigationContext";
import { useLibrarySyncActivity } from "../../context/LibrarySyncActivityContext";
import { useToolsActivity } from "../../context/ToolsActivityContext";
import {
  useUserSettingsSlice,
  useUserStateActions,
  useUserStateSelector,
  useUserStateStatus,
} from "../../context/UserStateContext";
import { useMatchMedia } from "../../hooks/useMatchMedia";
import {
  ensureAppForegroundListeners,
  isAppInForeground,
  subscribeAppForeground,
} from "../../hooks/useAppForeground";
import { setVisualSurfaceContext } from "../../hooks/useVisualSurfaceActive";
import { usePlayerDockCssVars } from "../../hooks/usePlayerDockCssVars";
import { useViewportHeight } from "../../hooks/useViewportHeight";
import { useSyncStatusSnackbar } from "../../hooks/useSyncStatusSnackbar";
import { MOBILE_LAYOUT_MQ } from "../../lib/breakpoints";
import { libraryPollDelayMs, shouldSkipLibraryPoll } from "../../lib/libraryPollSchedule";
import { requestNebulaFullscreen } from "../../lib/nebulaFullscreen";
import {
  findLibraryTrackByRelPath,
  lookupByRelPathAliases,
  openArtistInLibrary,
  openTrackInLibrary,
  resolveTrackFromLibrary,
} from "../../lib/libraryNav";
import { useI18n } from "../../i18n/useI18n";
import {
  fetchLibraryChanges,
  fetchLibraryDelta,
  fetchLibrarySnapshot,
  isBackendUnreachableError,
} from "../../lib/api";
import { onBackendRecovery, scheduleBackendRecovery } from "../../lib/backendRecovery";
import { isRekordClientEmbed } from "../toolsViewShared";
import { clientLegacyLibrary } from "../../lib/libraryIndex";
import {
  applyLibraryDeltaPayload,
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
import { ViewErrorBoundary } from "../ViewErrorBoundary";
import { RekordViewLoadingFallback } from "../RekordViewLoadingFallback";
import { PlayerDock } from "../PlayerDock/PlayerDock";
import { MobileBottomNav } from "../MobileBottomNav/MobileBottomNav";
import { SideBar } from "./SideBar/SideBar";
import { SyncStatusSnackbar } from "./SyncStatusSnackbar";
import { OfflineBanner } from "../OfflineBanner";
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
const LazyStudioView = lazy(() =>
  import("../../views/StudioView/StudioView").then((m) => ({
    default: m.StudioView,
  }))
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
  const { updateSettings, settings } = useUserSettingsSlice();
  useEffect(() => {
    setVisualSurfaceContext({
      section: route.section,
      libBrowse: settings.libBrowse,
    });
  }, [route.section, settings.libBrowse]);
  const { ready: userReady, error: userError } = useUserStateStatus();
  const favorites = useUserStateSelector((s) => s.state.favorites);
  const trackPlayCounts = useUserStateSelector((s) => s.state.trackPlayCounts);
  const recentTracks = useUserStateSelector((s) => s.state.recent);
  const {
    syncUserStateFromServer,
    rehydrateTrackListsFromLibrary,
    rehydrateShuffleExclusionsFromIndex,
  } = useUserStateActions();
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
      const mobileClient =
        electronClient || isRekordClientEmbed();
      if (message === "errors.backendUnreachable") {
        return t(
          mobileClient
            ? "errors.backendUnreachableClient"
            : electronClient
              ? "errors.backendUnreachableElectron"
              : "errors.backendUnreachable",
        );
      }
      if (isBackendUnreachableError(message)) {
        return t(
          mobileClient
            ? "errors.backendUnreachableClient"
            : electronClient
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
  const indexLoadedRef = useRef(false);
  const resyncTracksRef = useRef(p.resyncTracksFromIndex);
  resyncTracksRef.current = p.resyncTracksFromIndex;
  const libraryReconcileDebounceRef = useRef<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);
  const [syncTapAnim, setSyncTapAnim] = useState(false);
  const libraryPollFailuresRef = useRef(0);
  const libraryPollUnchangedRef = useRef(0);
  const libraryPollInFlightRef = useRef(false);
  const libraryPollTimerRef = useRef<number | null>(null);
  const libraryPollIsPlayingRef = useRef(p.isPlaying);
  libraryPollIsPlayingRef.current = p.isPlaying;

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
      const task = Promise.resolve(fetchLibrarySnapshot())
        .then(async (snapshot) => {
          if (seq !== refreshSeqRef.current) return;
          const libraryData = snapshot.index;
          const dashboardData = snapshot.dashboard;
          setIndex((prev) => {
            const next = mergeLibraryIndexFromServer(prev, libraryData);
            syncLibraryAlbumArtworkFromIndex(next);
            return next;
          });
          setDashboard(dashboardData);
          setError(null);
          indexLoadedRef.current = true;
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
      setIndex((prev) => {
        const next = applyLibraryDeltaToIndex(prev, delta);
        if (next) {
          syncLibraryAlbumArtworkFromIndex(next);
          queueMicrotask(() => p.resyncTracksFromIndex(next));
        }
        return next;
      });
      if (libraryDeltaTouchesCover(delta)) p.syncMediaSessionNow();
      if (reconcile) scheduleDebouncedLibraryReconcile();
    },
    [p, scheduleDebouncedLibraryReconcile]
  );

  const applyLibraryDeltas = useCallback(
    (deltas: LibraryEntityDelta[], reconcile = false) => {
      if (!deltas.length) return;
      setIndex((prev) => {
        const next = applyLibraryDeltasToIndex(prev, deltas);
        if (next) syncLibraryAlbumArtworkFromIndex(next);
        return next;
      });
      if (deltas.some(libraryDeltaTouchesCover)) p.syncMediaSessionNow();
      if (reconcile) scheduleDebouncedLibraryReconcile();
    },
    [p, scheduleDebouncedLibraryReconcile]
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
    return onBackendRecovery(() => {
      if (indexRef.current) {
        void reconcileLibrary({ mode: "now", syncUser: true });
      } else {
        void reconcileLibrary({ mode: "manual", syncUser: true });
      }
    });
  }, [reconcileLibrary]);

  useEffect(() => {
    if (indexLoadedRef.current) return;
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
    if (!indexLoadedRef.current || !index) return;
    ensureAppForegroundListeners();

    const scheduleNextPoll = (delayMs: number) => {
      if (libraryPollTimerRef.current != null) {
        window.clearTimeout(libraryPollTimerRef.current);
      }
      libraryPollTimerRef.current = window.setTimeout(runPoll, delayMs);
    };

    const finishPollCycle = () => {
      libraryPollInFlightRef.current = false;
      const foreground = isAppInForeground();
      scheduleNextPoll(
        libraryPollDelayMs({
          foreground,
          consecutiveUnchanged: libraryPollUnchangedRef.current,
          consecutiveFailures: libraryPollFailuresRef.current,
          isPlaying: libraryPollIsPlayingRef.current,
        }),
      );
    };

    const runPoll = () => {
      libraryPollTimerRef.current = null;
      if (shouldSkipLibraryPoll(isAppInForeground())) {
        scheduleNextPoll(
          libraryPollDelayMs({
            foreground: false,
            consecutiveUnchanged: libraryPollUnchangedRef.current,
            consecutiveFailures: libraryPollFailuresRef.current,
            isPlaying: libraryPollIsPlayingRef.current,
          }),
        );
        return;
      }
      if (backgroundRefreshRef.current || libraryPollInFlightRef.current) {
        finishPollCycle();
        return;
      }
      libraryPollInFlightRef.current = true;
      const sinceEpoch = indexEpochRef.current;
      void fetchLibraryChanges(sinceEpoch)
        .then(async (snap) => {
          libraryPollFailuresRef.current = 0;
          if (!snap.changed || snap.scanning || backgroundRefreshRef.current) {
            indexEpochRef.current = snap.indexEpoch;
            if (!snap.changed && !snap.scanning) {
              libraryPollUnchangedRef.current += 1;
            } else {
              libraryPollUnchangedRef.current = 0;
            }
            return;
          }
          libraryPollUnchangedRef.current = 0;
          const delta = await fetchLibraryDelta(sinceEpoch);
          indexEpochRef.current = snap.indexEpoch;
          if (!delta.changed) return;
          if (delta.fullRefreshRecommended) {
            void runCoalescedBackgroundRefresh();
            return;
          }
          setIndex((prev) => {
            const next = applyLibraryDeltaPayload(prev, delta);
            if (!next) {
              void runCoalescedBackgroundRefresh();
              return prev;
            }
            syncLibraryAlbumArtworkFromIndex(next);
            queueMicrotask(() => resyncTracksRef.current(next));
            return next;
          });
          indexEpochRef.current = delta.indexEpoch;
        })
        .catch(() => {
          libraryPollFailuresRef.current += 1;
          if (libraryPollFailuresRef.current >= 2) {
            libraryPollFailuresRef.current = 0;
            scheduleBackendRecovery("poll");
          }
        })
        .finally(finishPollCycle);
    };

    const unsubForeground = subscribeAppForeground((fg) => {
      if (libraryPollTimerRef.current != null) {
        window.clearTimeout(libraryPollTimerRef.current);
        libraryPollTimerRef.current = null;
      }
      if (fg) {
        libraryPollUnchangedRef.current = 0;
        runPoll();
        return;
      }
      scheduleNextPoll(
        libraryPollDelayMs({
          foreground: false,
          consecutiveUnchanged: libraryPollUnchangedRef.current,
          consecutiveFailures: libraryPollFailuresRef.current,
          isPlaying: libraryPollIsPlayingRef.current,
        }),
      );
    });

    scheduleNextPoll(
      libraryPollDelayMs({
        foreground: isAppInForeground(),
        consecutiveUnchanged: 0,
        consecutiveFailures: 0,
        isPlaying: libraryPollIsPlayingRef.current,
      }),
    );

    return () => {
      if (libraryPollTimerRef.current != null) {
        window.clearTimeout(libraryPollTimerRef.current);
        libraryPollTimerRef.current = null;
      }
      unsubForeground();
    };
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

  const { resyncTracksFromIndex } = p;
  useEffect(() => {
    if (!index || !userReady) return;
    resyncTracksFromIndex(index);
    const sig = libraryIndexRehydrateSig(index);
    const sigChanged = sig !== indexLibrarySigRef.current;
    if (sigChanged) indexLibrarySigRef.current = sig;
    startTransition(() => {
      rehydrateTrackListsFromLibrary(index);
      if (sigChanged) rehydrateShuffleExclusionsFromIndex(index);
    });
  }, [
    index,
    resyncTracksFromIndex,
    userReady,
    rehydrateTrackListsFromLibrary,
    rehydrateShuffleExclusionsFromIndex,
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
    return favorites
      .map((relPath) => findLibraryTrackByRelPath(index.tracks, relPath))
      .filter((track): track is LibraryTrackIndex => Boolean(track))
      .sort(
        (a, b) =>
          (lookupByRelPathAliases(trackPlayCounts, b.relPath) ?? 0) -
            (lookupByRelPathAliases(trackPlayCounts, a.relPath) ?? 0) ||
          a.title.localeCompare(b.title, undefined, { numeric: true })
      );
  }, [index, route.section, favorites, trackPlayCounts]);

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
        if (section === "libreria") {
          updateSettings({ libBrowse: "artists" });
        }
        navigate({ section });
      });
    },
    [closeLibrarySearch, navigate, openStudioListen, p.queue.length, setRhythmOpen, updateSettings],
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
      } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
        if (!p.current) return;
        event.preventDefault();
        /* Legge il tempo dall'elemento audio (lo stato React è throttlato);
           il seek non cambia lo stato play/pausa. */
        const audio = p.audioRef.current;
        const at = audio ? audio.currentTime : readPlayerProgressTime();
        const dur =
          audio && Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : p.duration;
        const delta = event.code === "ArrowLeft" ? -15 : 15;
        const max = dur > 0 ? Math.max(0, dur - 0.5) : Number.POSITIVE_INFINITY;
        p.seek(Math.min(max, Math.max(0, at + delta)));
      } else if (event.code === "KeyI") {
        event.preventDefault();
        openStudioListen();
      } else if (event.code === "KeyN") {
        event.preventDefault();
        requestNebulaFullscreen();
        updateSettings({ libBrowse: "nebula" });
        startTransition(() => navigate({ section: "libreria" }));
      } else if (event.code === "KeyP") {
        event.preventDefault();
        if (p.queue.length > 0) setRhythmOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, openLibrarySearch, openStudioListen, p, setRhythmOpen, updateSettings]);

  const onLibraryHome = useCallback(() => {
    closeLibrarySearch();
    setLibraryHomeTick((n) => n + 1);
    startTransition(() => {
      updateSettings({ libBrowse: "artists" });
      navigate({ section: "libreria", artist: null, album: null });
    });
  }, [navigate, closeLibrarySearch, updateSettings]);

  const currentView = (() => {
    if (route.section === "settings") {
      return (
        <ViewErrorBoundary label="Settings">
          <Suspense fallback={<RekordViewLoadingFallback />}>
            <LazySettingsView index={index} />
          </Suspense>
        </ViewErrorBoundary>
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
          <ViewErrorBoundary label="Dashboard">
            <Suspense fallback={<RekordViewLoadingFallback />}>
              <LazyDashboardView
                dashboard={dashboard}
                index={index}
                onOpenAlbum={navToLibraryAlbum}
                onOpenSection={navToSection}
              />
            </Suspense>
          </ViewErrorBoundary>
        );
      case "libreria":
        return (
          <ViewErrorBoundary label="Library">
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
          </ViewErrorBoundary>
        );
      case "studio":
        return (
          <div className="view-page view-page--studio">
            <ViewErrorBoundary label="Studio">
              <Suspense fallback={<RekordViewLoadingFallback />}>
                <LazyStudioView
                  library={legacyLibrary}
                  libraryIndex={index}
                  onReconcileLibrary={reconcileLibrary}
                  onLibraryDelta={applyLibraryDelta}
                  onLibraryDeltas={applyLibraryDeltas}
                  onOpenSection={navToSection}
                />
              </Suspense>
            </ViewErrorBoundary>
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
              tracks={recentTracks}
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
              {userError ? (
                <div className={styles.banner}>
                  {userError === "errors.backendUnreachable"
                    ? formatLoadError(userError)
                    : `${t("persist.banner")} ${formatLoadError(userError)}`}
                </div>
              ) : null}

              <main
                className={`content-shell ${styles.content}`}
              >
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
            onOpenLibraryForTrack={smartNavToLibraryForTrack}
            resolvePlaybackTrack={resolvePlaybackTrack}
            libraryTracks={index?.tracks}
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
          <OfflineBanner />
        </div>
      </AlbumMetaEditProvider>
    </TrackMetaEditProvider>
    </LibraryArtworkProvider>
    </StudioNavigationProvider>
  );
}
