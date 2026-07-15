/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  fetchUserState,
  getSelectedAccountId,
  isBackendUnreachableError,
} from "../lib/api";
import { onBackendRecovery } from "../lib/backendRecovery";
import { useLibrarySyncActivity } from "./LibrarySyncActivityContext";
import { readLegacyLocalShuffleMigrated, clearLegacyLocalShuffle } from "../lib/legacyShuffleLocal";
import { normalizeShuffleAlbumKeysWithIndex } from "../lib/shuffleExclusionKeys";
import { DEFAULT_CUSTOM_THEME } from "../lib/themeCatalog";
import { touchListeningActivity } from "../lib/achievements";
import {
  buildLibraryTrackLookup,
  isFavoriteRelPath,
  lookupByRelPathAliases,
  lookupLibraryTrack,
  migrateLooseTrackPathsInUserState,
} from "../lib/libraryNav";
import { enrichedTracksNeedPlayerResync } from "../lib/libraryIndex";
import { isCompactRenderTarget } from "../lib/renderQuality";
import { isTrackAlbumShuffleExcluded } from "../lib/randomExclusions";
import {
  applyUserStatePatchFields,
  compactUserStatePatch,
  mergeUserStatePatches,
} from "../lib/userStatePatch";
import { createPlaylistOps } from "../userState/playlistOps";
import { createUserStateSyncEngine } from "../userState/syncEngine";
import {
  normalizeCustomTheme,
  normalizeGlassOpacity,
  useThemeDomEffects,
} from "../userState/themeManager";
import { mergePartialUserSettings, type UserSettingsPatch } from "../lib/userSettingsMerge";
import {
  gameResultToPlectrBest,
  isBetterPlectrScore,
  plectrBestFromUserState,
} from "../game/lib/plectrStorage";
import type { GameResult } from "../game/types";
import {
  APP_LOCALES,
  THEME_MODES,
  type AppLocale,
  type AudioCrossfadeSec,
  type EnrichedTrack,
  type LibraryIndex,
  type QueueState,
  type ThemeMode,
  type UserPlaylist,
  type UserSettings,
  type UserStatePatch,
  type UserStateV1,
} from "../types";

const LEGACY_KEYS = {
  playlists: "rekord-playlists",
  favorites: "rekord-favorites",
  recent: "rekord-recent",
  vizMode: "rekord-viz",
};
const WPP_STORAGE = {
  playlists: "wpp-playlists",
  favorites: "wpp-favorites",
  recent: "wpp-recent",
  vizMode: "wpp-viz",
};

function defaultSettings(): UserSettings {
  return {
    theme: "midnight",
    customTheme: DEFAULT_CUSTOM_THEME,
    vizMode: "hmb",
    restoreSession: true,
    defaultTab: "dashboard",
    locale: "en",
    libBrowse: "artists",
    libOverviewSort: "name",
    artistAlbumSort: "date",
    audioCrossfadeSec: 3,
    plectrDisableVizBackdrop: isCompactRenderTarget(),
    glassSurfaces: false,
    glassOpacity: 62,
  };
}

function normalizeAudioCrossfadeSec(raw: Partial<UserSettings> | UserSettingsPatch): AudioCrossfadeSec {
  const v = raw.audioCrossfadeSec;
  if (v === 5 || v === 3 || v === 0) return v;
  const legacy = raw as { trackChangeTransitions?: boolean };
  return legacy.trackChangeTransitions === false ? 0 : 3;
}

function normalizeSettings(raw: Partial<UserSettings> | UserSettingsPatch): UserSettings {
  const locale: AppLocale = (APP_LOCALES as readonly string[]).includes(
    raw.locale as string
  )
    ? (raw.locale as AppLocale)
    : "en";
  const libBrowse: UserSettings["libBrowse"] =
    raw.libBrowse === "genres"
      ? "genres"
      : raw.libBrowse === "moods"
        ? "moods"
        : raw.libBrowse === "nebula"
          ? "nebula"
          : "artists";
  const libOverviewSort: UserSettings["libOverviewSort"] =
    raw.libOverviewSort === "plays" ? "plays" : "name";
  const rawAlbumSort = raw.artistAlbumSort;
  const artistAlbumSort: UserSettings["artistAlbumSort"] =
    rawAlbumSort === "name" || rawAlbumSort === "plays" || rawAlbumSort === "date"
      ? rawAlbumSort
      : "date";
  return {
    theme:
      raw.theme != null &&
      (THEME_MODES as readonly string[]).includes(raw.theme as string)
        ? (raw.theme as ThemeMode)
        : "midnight",
    customTheme: normalizeCustomTheme(raw.customTheme),
    vizMode: (() => {
      const legacy = raw.vizMode as string | undefined;
      let m: typeof raw.vizMode = raw.vizMode;
      if (legacy === "soft" || legacy === "horizon" || legacy === "embers")
        m = "signals";
      else if (legacy === "prism") m = "bars";
      // "karaoke" non è più selezionabile: vive solo nel pulsante microfono.
      return m === "mirror" ||
        m === "osc" ||
        m === "oscSoft" ||
        m === "hmb" ||
        m === "bars" ||
        m === "signals" ||
        m === "discowall"
        ? m
        : "hmb";
    })(),
    restoreSession: raw.restoreSession !== false,
    defaultTab:
      typeof raw.defaultTab === "string" && raw.defaultTab.trim()
        ? raw.defaultTab
        : "dashboard",
    locale,
    libBrowse,
    libOverviewSort,
    artistAlbumSort,
    audioCrossfadeSec: normalizeAudioCrossfadeSec(raw),
    plectrDisableVizBackdrop:
      raw.plectrDisableVizBackdrop === false
        ? false
        : raw.plectrDisableVizBackdrop === true || isCompactRenderTarget(),
    glassSurfaces: raw.glassSurfaces === true,
    glassOpacity: normalizeGlassOpacity(raw.glassOpacity),
  };
}

function userSettingsEqual(a: UserSettings, b: UserSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeUserState(s: UserStateV1): UserStateV1 {
  const migrated = migrateLooseTrackPathsInUserState(s);
  const revRaw = migrated.revision;
  const revision =
    typeof revRaw === "number" &&
    Number.isFinite(revRaw) &&
    revRaw >= 1
      ? Math.floor(revRaw)
      : 1;
  const rawCounts = migrated.trackPlayCounts || {};
  const trackPlayCounts = Object.fromEntries(
    Object.entries(rawCounts).filter(
      ([relPath, count]) =>
        Boolean(relPath) && Number.isFinite(count) && Number(count) > 0
    )
  ) as Record<string, number>;
  return {
    ...migrated,
    revision,
    trackPlayCounts,
    plectrBests: migrated.plectrBests ?? {},
    settings: normalizeSettings(migrated.settings),
    shuffleExcludedAlbumIds: uniqStrings(migrated.shuffleExcludedAlbumIds || []),
    shuffleExcludedTrackRelPaths: uniqStrings(
      migrated.shuffleExcludedTrackRelPaths || []
    ),
  };
}

function defaultUserState(): UserStateV1 {
  return {
    version: 1,
    revision: 1,
    favorites: [],
    recent: [],
    trackPlayCounts: {},
    playlists: [],
    queue: { tracks: [], currentIndex: 0 },
    settings: defaultSettings(),
    shuffleExcludedAlbumIds: [],
    shuffleExcludedTrackRelPaths: [],
    migratedLegacy: false,
    playlistsMigrated: false,
    plectrBests: {},
  };
}

function uniqStrings(list: string[]) {
  return [...new Set(list.filter(Boolean))];
}

function isLibraryRequiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Library folder not configured|LIBRARY_REQUIRED|Set it in server Settings/i.test(msg);
}

function applyUserStatePatchLocal(
  base: UserStateV1,
  patch: UserStatePatch
): UserStateV1 {
  return applyUserStatePatchFields(base, patch, normalizeSettings, normalizeUserState);
}

/**
 * Patch "full" dallo stato React. La coda è esclusa di proposito: vive in
 * `queueStateRef` e viene persistita solo via `enqueueQueuePatch` (lo
 * state React contiene solo lo snapshot di idratazione, potenzialmente stale).
 */
function userStateToPatch(state: UserStateV1, omitPlaylists = false): UserStatePatch {
  return compactUserStatePatch({
    favorites: state.favorites,
    recent: state.recent,
    trackPlayCounts: state.trackPlayCounts,
    ...(omitPlaylists ? {} : { playlists: state.playlists }),
    settings: state.settings,
    shuffleExcludedAlbumIds: state.shuffleExcludedAlbumIds,
    shuffleExcludedTrackRelPaths: state.shuffleExcludedTrackRelPaths,
    trackMoods: state.trackMoods,
    plectrBests: state.plectrBests,
    migratedLegacy: state.migratedLegacy,
    trackMoodsMigrated: state.trackMoodsMigrated,
    playlistsMigrated: state.playlistsMigrated,
  });
}

function readJsonKordOrWpp<T>(key: string, wppKey: string, fallback: T): T {
  try {
    const rawK = localStorage.getItem(key);
    if (rawK != null) return JSON.parse(rawK) as T;
    const rawW = localStorage.getItem(wppKey);
    if (rawW != null) return JSON.parse(rawW) as T;
  } catch {
    return fallback;
  }
  return fallback;
}

function legacyImport(): Partial<UserStateV1> {
  const playlists = readJsonKordOrWpp<UserPlaylist[]>(
    LEGACY_KEYS.playlists,
    WPP_STORAGE.playlists,
    [],
  );
  const favorites = readJsonKordOrWpp<string[]>(
    LEGACY_KEYS.favorites,
    WPP_STORAGE.favorites,
    [],
  );
  const recent = readJsonKordOrWpp<EnrichedTrack[]>(
    LEGACY_KEYS.recent,
    WPP_STORAGE.recent,
    [],
  );
  const vizMode =
    localStorage.getItem(LEGACY_KEYS.vizMode) ??
    localStorage.getItem(WPP_STORAGE.vizMode);
  return {
    playlists,
    favorites,
    recent,
    settings:
      vizMode === "bars" ||
      vizMode === "mirror" ||
      vizMode === "osc" ||
      vizMode === "oscSoft" ||
      vizMode === "hmb" ||
      vizMode === "signals" ||
      vizMode === "discowall" ||
      vizMode === "embers" ||
      vizMode === "karaoke" ||
      vizMode === "rekord" ||
      vizMode === "horizon" ||
      vizMode === "soft" ||
      vizMode === "prism"
        ? {
            ...defaultSettings(),
            vizMode:
              vizMode === "soft" ||
              vizMode === "horizon" ||
              vizMode === "embers"
                ? "signals"
                : vizMode === "prism"
                  ? "bars"
                  : vizMode === "rekord" || vizMode === "karaoke"
                    ? "hmb"
                    : vizMode,
          }
        : undefined,
  };
}

function mergeLegacy(remote: UserStateV1): UserStateV1 {
  const legacy = legacyImport();
  const legacyPlaylists = (legacy.playlists as UserPlaylist[]) || [];
  if (remote.migratedLegacy && remote.playlistsMigrated) return remote;
  if (remote.migratedLegacy) {
    return {
      ...remote,
      playlists:
        remote.playlists.length > 0 || legacyPlaylists.length === 0
          ? remote.playlists
          : legacyPlaylists,
      playlistsMigrated: true,
    };
  }
  return {
    ...remote,
    favorites: uniqStrings([
      ...(remote.favorites || []),
      ...((legacy.favorites as string[]) || []),
    ]),
    recent: [...(legacy.recent || []), ...(remote.recent || [])]
      .filter(
        (track, index, arr) =>
          arr.findIndex((item) => item.relPath === track.relPath) === index
      )
      .slice(0, 30),
    playlists:
      remote.playlists.length > 0
        ? remote.playlists
        : legacyPlaylists,
    settings: normalizeSettings({
      ...remote.settings,
      ...(legacy.settings || {}),
      defaultTab: remote.settings?.defaultTab || "dashboard",
    }),
    migratedLegacy: true,
    playlistsMigrated: true,
  };
}

type UserStateSnapshot = {
  state: UserStateV1;
  ready: boolean;
  saving: boolean;
  error: string | null;
  favorites: Set<string>;
  selectedPlaylist: string | null;
};

type UserStateActions = {
  setSelectedPlaylist: (id: string | null) => void;
  toggleFavorite: (relPath: string) => void;
  isFavorite: (relPath: string) => boolean;
  pushRecent: (track: EnrichedTrack) => void;
  getTrackPlayCount: (relPath: string) => number;
  incrementTrackPlayCount: (relPath: string) => void;
  setQueueSnapshot: (queue: QueueState) => void;
  /** Solo patch `queue` — debounce unificato nel writer (3s). */
  enqueueQueuePatch: (queue: QueueState) => void;
  flushUserStateNow: (opts?: { silent?: boolean }) => void;
  updateSettings: (patch: UserSettingsPatch) => void;
  createPlaylist: (name: string) => string;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  addTrackToPlaylist: (id: string, track: EnrichedTrack) => void;
  removeTrackFromPlaylist: (id: string, relPath: string) => void;
  saveQueueAsPlaylist: (name: string, queue: EnrichedTrack[]) => string;
  rehydrateTrackListsFromLibrary: (index: LibraryIndex) => void;
  toggleShuffleExcludedAlbum: (albumId: string) => void;
  toggleShuffleExcludedTrack: (relPath: string) => void;
  setShuffleTracksExcludedBulk: (relPaths: readonly string[], exclude: boolean) => void;
  rehydrateShuffleExclusionsFromIndex: (index: LibraryIndex) => void;
  stripUserStateForRelPaths: (deletedRelPaths: string[]) => void;
  syncUserStateFromServer: () => Promise<void>;
  savePlectrBest: (relPath: string, result: GameResult) => boolean;
};

type UserStateContextValue = UserStateSnapshot & UserStateActions;

type UserStateStoreApi = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UserStateSnapshot;
};

const UserStateStoreContext = createContext<UserStateStoreApi | null>(null);
const UserStateActionsContext = createContext<UserStateActions | null>(null);

/**
 * Store leggero per le righe delle liste brani: espone preferiti, conteggi
 * ascolti ed esclusioni shuffle via useSyncExternalStore, così le righe non si
 * sottoscrivono all'intero UserStateContext.
 */
type TrackRowUserStore = {
  subscribe: (listener: () => void) => () => void;
  isFavorite: (relPath: string) => boolean;
  getTrackPlayCount: (relPath: string) => number;
  isShuffleExcludedTrack: (relPath: string) => boolean;
  isAlbumShuffleExcluded: (track: EnrichedTrack) => boolean;
  toggleFavorite: (relPath: string) => void;
  toggleShuffleExcludedTrack: (relPath: string) => void;
};

const TrackRowUserContext = createContext<TrackRowUserStore | null>(null);

export function UserStateProvider({ children }: { children: React.ReactNode }) {
  const { beginActivity: beginLibrarySyncActivity } = useLibrarySyncActivity();
  const beginLibrarySyncActivityRef = useRef(beginLibrarySyncActivity);
  useEffect(() => {
    beginLibrarySyncActivityRef.current = beginLibrarySyncActivity;
  }, [beginLibrarySyncActivity]);
  const [state, setState] = useState<UserStateV1>(defaultUserState);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null);

  const syncEngineRef = useRef<ReturnType<typeof createUserStateSyncEngine> | null>(
    null,
  );
  if (!syncEngineRef.current) {
    syncEngineRef.current = createUserStateSyncEngine({
      setState,
      setSaving,
      setError,
      beginLibrarySyncActivity: (key) =>
        beginLibrarySyncActivityRef.current(key),
      normalizeUserState,
      mergeLegacy,
      applyUserStatePatchLocal,
      userStateToPatch,
    });
  }
  const sync = syncEngineRef.current;
  const {
    dirtyRef,
    playlistDirtyRef,
    hydratedRef,
    queueStateRef,
    pendingPatchRef,
    inFlightPatchRef,
    flushTimerRef,
    hydratedAccountIdRef,
    commit,
    enqueueQueuePatch,
    setQueueSnapshot,
    flushUserStateNow,
    flushPendingPatch,
    schedulePendingFlush,
    syncUserStateFromServer,
  } = sync;

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;
    let retryAttempts = 0;

    const clearRetry = () => {
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const applyRemote = (remote: UserStateV1) => {
      if (!active) return;
      clearRetry();
      // Pin dell'account che ha idratato questo stato: le patch generate
      // da qui devono sempre finire su questo account, anche se localStorage
      // cambia prima del flush (switch account + pagehide).
      hydratedAccountIdRef.current = getSelectedAccountId();

      let merged = normalizeUserState(mergeLegacy(remote));
      if (
        !remote.migratedLegacy ||
        (merged.playlists.length > 0 &&
          (merged.playlistsMigrated !== remote.playlistsMigrated ||
            merged.playlists !== remote.playlists))
      ) {
        playlistDirtyRef.current = true;
      }

      const fromLocal = readLegacyLocalShuffleMigrated();
      if (fromLocal.albumKeys.length > 0 || fromLocal.trackPaths.length > 0) {
        merged = normalizeUserState({
          ...merged,
          shuffleExcludedAlbumIds: uniqStrings([
            ...merged.shuffleExcludedAlbumIds,
            ...fromLocal.albumKeys,
          ]),
          shuffleExcludedTrackRelPaths: uniqStrings([
            ...merged.shuffleExcludedTrackRelPaths,
            ...fromLocal.trackPaths,
          ]),
        });
        clearLegacyLocalShuffle();
      }

      const playlistsNeedPersist =
        merged.playlists.length > 0 &&
        (merged.playlistsMigrated !== remote.playlistsMigrated ||
          merged.playlists !== remote.playlists);
      const needsInitialPersist =
        fromLocal.albumKeys.length > 0 ||
        fromLocal.trackPaths.length > 0 ||
        !remote.migratedLegacy ||
        playlistsNeedPersist;
      if (needsInitialPersist) {
        pendingPatchRef.current = mergeUserStatePatches(
          pendingPatchRef.current,
          userStateToPatch(merged)
        );
      }

      let localUnsaved = mergeUserStatePatches(
        inFlightPatchRef.current,
        pendingPatchRef.current
      );
      const pendingGlass = localUnsaved.settings?.glassOpacity;
      const remoteGlass = remote.settings?.glassOpacity;
      if (
        pendingGlass != null &&
        remoteGlass != null &&
        Number(pendingGlass) !== Number(remoteGlass)
      ) {
        const { settings, ...rest } = localUnsaved;
        const settingsRest = settings ? { ...settings } : undefined;
        if (settingsRest) delete settingsRest.glassOpacity;
        localUnsaved =
          settingsRest && Object.keys(settingsRest).length > 0
            ? { ...rest, settings: settingsRest }
            : rest;
        if (pendingPatchRef.current.settings?.glassOpacity != null) {
          const ps = { ...pendingPatchRef.current.settings };
          delete ps.glassOpacity;
          pendingPatchRef.current =
            Object.keys(ps).length > 0
              ? { ...pendingPatchRef.current, settings: ps }
              : (() => {
                  const { settings: _s, ...pRest } = pendingPatchRef.current;
                  return pRest;
                })();
        }
      }
      const hasLocalUnsaved = Object.keys(localUnsaved).length > 0;
      dirtyRef.current = needsInitialPersist || hasLocalUnsaved;

      const preserved = hasLocalUnsaved
        ? applyUserStatePatchLocal(merged, localUnsaved)
        : merged;
      queueStateRef.current = preserved.queue;
      setState((prev) => {
        if (!hasLocalUnsaved) return merged;
        return {
          ...preserved,
          revision: Math.max(
            Number(merged.revision || 1),
            Number(prev.revision || 1)
          ),
        };
      });
      setError(null);
      setReady(true);
      hydratedRef.current = true;
      if (dirtyRef.current && Object.keys(pendingPatchRef.current).length > 0) {
        schedulePendingFlush();
      }
    };

    const scheduleRetry = (opts?: { unreachable?: boolean }) => {
      if (!active) return;
      const maxAttempts = opts?.unreachable ? 10 : 6;
      if (retryAttempts >= maxAttempts) return;
      clearRetry();
      const baseDelay = opts?.unreachable ? 900 : 600;
      const delay = Math.min(4000, baseDelay * Math.pow(1.55, retryAttempts));
      retryAttempts += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        fetchUserState()
          .then((remote) => applyRemote(remote))
          .catch((err: unknown) => {
            if (!active) return;
            if (isLibraryRequiredError(err)) return;
            if (isBackendUnreachableError(err)) {
              scheduleRetry({ unreachable: true });
              return;
            }
            scheduleRetry();
          });
      }, delay);
    };

    const endLoadActivity = beginLibrarySyncActivityRef.current(
      "sync.activity.loadingUserState"
    );
    fetchUserState()
      .then((remote) => applyRemote(remote))
      .catch((err: unknown) => {
        if (!active) return;
        const fallback = mergeLegacy(defaultUserState());
        setState(fallback);
        setError(
          isLibraryRequiredError(err)
            ? null
            : isBackendUnreachableError(err)
              ? "errors.backendUnreachable"
              : String(err)
        );
        setReady(true);
        hydratedRef.current = true;

        // IMPORTANT: non accodare patch col fallback (vuoto). Un errore transient
        // durante il reload potrebbe altrimenti sovrascrivere lo user-state remoto.
        dirtyRef.current = false;
        pendingPatchRef.current = {};
        inFlightPatchRef.current = {};

        if (!isLibraryRequiredError(err) && isBackendUnreachableError(err)) {
          scheduleRetry({ unreachable: true });
        } else if (!isLibraryRequiredError(err) && !isBackendUnreachableError(err)) {
          scheduleRetry();
        }
      })
      .finally(() => {
        endLoadActivity();
      });
    return () => {
      active = false;
      clearRetry();
    };
  }, []);

  useEffect(() => {
    const onPageHide = () => flushPendingPatch();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [flushPendingPatch]);

  useEffect(
    () => () => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    },
    [flushTimerRef],
  );

  useThemeDomEffects(state.settings);

  const syncUserStateFromServerRef = useRef(syncUserStateFromServer);
  useEffect(() => {
    syncUserStateFromServerRef.current = syncUserStateFromServer;
  }, [syncUserStateFromServer]);

  useEffect(() => {
    return onBackendRecovery(() => {
      void syncUserStateFromServerRef.current();
      if (dirtyRef.current) schedulePendingFlush();
    });
  }, [dirtyRef, schedulePendingFlush]);

  const toggleFavorite = useCallback(
    (relPath: string) => {
      commit((prev) => {
        const on = prev.favorites.includes(relPath);
        return {
          ...prev,
          favorites: on
            ? prev.favorites.filter((item) => item !== relPath)
            : [...prev.favorites, relPath],
        };
      }, { patch: (next) => ({ favorites: next.favorites }) });
    },
    [commit]
  );

  const savePlectrBest = useCallback(
    (relPath: string, result: GameResult) => {
      if (result.score <= 0 && result.hits <= 0) return false;
      let saved = false;
      commit(
        (prev) => {
          const current = plectrBestFromUserState(prev.plectrBests, relPath);
          if (!isBetterPlectrScore(result, current)) return prev;
          saved = true;
          const payload = gameResultToPlectrBest(result);
          return {
            ...prev,
            plectrBests: {
              ...(prev.plectrBests || {}),
              [relPath]: payload,
            },
          };
        },
        {
          immediate: true,
          silent: true,
          patch: (next, prev) => {
            const entry = next.plectrBests?.[relPath];
            const prevEntry = prev.plectrBests?.[relPath];
            if (!entry || entry === prevEntry) return {};
            return { plectrBests: { [relPath]: entry } };
          },
        }
      );
      return saved;
    },
    [commit]
  );

  const pushRecent = useCallback(
    (track: EnrichedTrack) => {
      commit((prev) => ({
        ...prev,
        recent: [
          track,
          ...prev.recent.filter((item) => item.relPath !== track.relPath),
        ].slice(0, 30),
      }), { patch: (next) => ({ recent: next.recent }) });
    },
    [commit]
  );

  const rehydrateTrackListsFromLibrary = useCallback(
    (libraryIndex: LibraryIndex) => {
      if (!hydratedRef.current) return;
      const lookup = buildLibraryTrackLookup(libraryIndex.tracks);
      type PlaylistTrackStub = {
        relPath: string;
        title: string;
        artist: string;
        album: string;
      };
      const mergePlaylistTrack = (
        _tr: PlaylistTrackStub,
        full: LibraryIndex["tracks"][number]
      ) => ({
        relPath: full.relPath,
        title: full.title,
        artist: full.artist,
        album: full.album,
      });
      const playlistTrackEqual = (a: PlaylistTrackStub, b: PlaylistTrackStub) =>
        a.relPath === b.relPath &&
        a.title === b.title &&
        a.artist === b.artist &&
        a.album === b.album;
      commit((prev) => {
        let recentChanged = false;
        const recent = prev.recent.map((t) => {
          const full = lookupLibraryTrack(lookup, t);
          if (!full || !enrichedTracksNeedPlayerResync(t, full)) return t;
          recentChanged = true;
          return full;
        });
        let playlistsChanged = false;
        const playlists = prev.playlists.map((pl) => {
          let plChanged = false;
          const tracks = pl.tracks.map((playlistTrack) => {
            const full = lookupLibraryTrack(lookup, playlistTrack);
            if (!full) return playlistTrack;
            const next = mergePlaylistTrack(playlistTrack, full);
            if (!playlistTrackEqual(playlistTrack, next)) plChanged = true;
            return next;
          });
          if (plChanged) playlistsChanged = true;
          return plChanged ? { ...pl, tracks } : pl;
        });
        if (!recentChanged && !playlistsChanged) return prev;
        return { ...prev, recent, playlists };
      }, { patch: (next, prev) => {
        if (
          next.recent === prev.recent &&
          next.playlists === prev.playlists
        ) {
          return {};
        }
        return { recent: next.recent, playlists: next.playlists };
      } });
    },
    [commit]
  );

  const rehydrateShuffleExclusionsFromIndex = useCallback(
    (libraryIndex: LibraryIndex) => {
      if (!hydratedRef.current) return;
      commit(
        (prev) => {
          const next = normalizeShuffleAlbumKeysWithIndex(
            libraryIndex,
            prev.shuffleExcludedAlbumIds
          );
          const s = prev.shuffleExcludedAlbumIds;
          const a = [...s].sort().join("\0");
          const b = [...next].sort().join("\0");
          if (a === b) return prev;
          return { ...prev, shuffleExcludedAlbumIds: next };
        },
        { patch: (next) => ({ shuffleExcludedAlbumIds: next.shuffleExcludedAlbumIds }) }
      );
    },
    [commit]
  );

  const toggleShuffleExcludedAlbum = useCallback(
    (albumId: string) => {
      commit(
        (prev) => {
          const list = prev.shuffleExcludedAlbumIds || [];
          const on = list.includes(albumId);
          return {
            ...prev,
            shuffleExcludedAlbumIds: on
              ? list.filter((x) => x !== albumId)
              : [...list, albumId],
          };
        },
        { immediate: true, patch: (next) => ({ shuffleExcludedAlbumIds: next.shuffleExcludedAlbumIds }) }
      );
    },
    [commit]
  );

  const toggleShuffleExcludedTrack = useCallback(
    (relPath: string) => {
      if (!relPath) return;
      commit(
        (prev) => {
          const list = prev.shuffleExcludedTrackRelPaths || [];
          const on = list.includes(relPath);
          return {
            ...prev,
            shuffleExcludedTrackRelPaths: on
              ? list.filter((x) => x !== relPath)
              : [...list, relPath],
          };
        },
        { immediate: true, patch: (next) => ({ shuffleExcludedTrackRelPaths: next.shuffleExcludedTrackRelPaths }) }
      );
    },
    [commit]
  );

  const setShuffleTracksExcludedBulk = useCallback(
    (relPaths: readonly string[], exclude: boolean) => {
      const paths = relPaths.filter(Boolean);
      if (!paths.length) return;
      commit(
        (prev) => {
          const set = new Set(prev.shuffleExcludedTrackRelPaths || []);
          for (const p of paths) {
            if (exclude) set.add(p);
            else set.delete(p);
          }
          return { ...prev, shuffleExcludedTrackRelPaths: [...set] };
        },
        { immediate: true, patch: (next) => ({ shuffleExcludedTrackRelPaths: next.shuffleExcludedTrackRelPaths }) }
      );
    },
    [commit]
  );

  const stripUserStateForRelPaths = useCallback(
    (deletedRelPaths: string[]) => {
      const deleted = new Set(deletedRelPaths.filter(Boolean));
      if (!deleted.size) return;
      // La coda live è in queueStateRef (lo state React ha solo lo snapshot
      // di idratazione): filtrala da lì e includila esplicitamente nel patch.
      const liveQueue = queueStateRef.current;
      const nextQueueTracks = liveQueue.tracks.filter(
        (tr) => !deleted.has(tr.relPath)
      );
      const oldCurrent = liveQueue.tracks[liveQueue.currentIndex];
      const nextCurrent = oldCurrent
        ? nextQueueTracks.findIndex((tr) => tr.relPath === oldCurrent.relPath)
        : -1;
      const nextQueue: QueueState = {
        tracks: nextQueueTracks,
        currentIndex:
          nextQueueTracks.length === 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  nextCurrent >= 0 ? nextCurrent : 0,
                  nextQueueTracks.length - 1
                )
              ),
      };
      queueStateRef.current = nextQueue;
      commit(
        (prev) => ({
          ...prev,
          favorites: prev.favorites.filter((rel) => !deleted.has(rel)),
          shuffleExcludedTrackRelPaths:
            prev.shuffleExcludedTrackRelPaths.filter((rel) => !deleted.has(rel)),
          trackPlayCounts: Object.fromEntries(
            Object.entries(prev.trackPlayCounts || {}).filter(
              ([rel]) => !deleted.has(rel)
            )
          ) as UserStateV1["trackPlayCounts"],
          plectrBests: Object.fromEntries(
            Object.entries(prev.plectrBests || {}).filter(
              ([rel]) => !deleted.has(rel)
            )
          ) as UserStateV1["plectrBests"],
          recent: prev.recent.filter((tr) => !deleted.has(tr.relPath)),
          playlists: prev.playlists.map((pl) => ({
            ...pl,
            tracks: pl.tracks.filter((tr) => !deleted.has(tr.relPath)),
          })),
          queue: nextQueue,
        }),
        {
          immediate: true,
          patch: (next) => ({
            ...userStateToPatch(next, !playlistDirtyRef.current),
            queue: nextQueue,
          }),
        }
      );
    },
    [commit]
  );

  const {
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    saveQueueAsPlaylist,
  } = useMemo(
    () => createPlaylistOps({ commit, setSelectedPlaylist }),
    [commit],
  );

  const getTrackPlayCount = useCallback(
    (relPath: string) => lookupByRelPathAliases(state.trackPlayCounts, relPath) ?? 0,
    [state.trackPlayCounts]
  );

  const incrementTrackPlayCount = useCallback(
    (relPath: string) => {
      if (!relPath) return;
      commit((prev) => ({
        ...prev,
        trackPlayCounts: {
          ...(prev.trackPlayCounts || {}),
          [relPath]: ((prev.trackPlayCounts || {})[relPath] ?? 0) + 1,
        },
      }), { patch: (next) => ({ trackPlayCounts: next.trackPlayCounts }) });
      touchListeningActivity();
    },
    [commit]
  );

  const updateSettings = useCallback(
    (patch: UserSettingsPatch) => {
      commit(
        (prev) => {
          const merged = normalizeSettings(
            mergePartialUserSettings(prev.settings, patch),
          );
          if (userSettingsEqual(prev.settings, merged)) return prev;
          return {
            ...prev,
            settings: merged,
          };
        },
        {
          immediate: true,
          patch: (next, prev) => {
            if (next.settings === prev.settings) return {};
            return {
              settings: mergePartialUserSettings(prev.settings, patch),
            };
          },
        },
      );
    },
    [commit],
  );

  const favorites = useMemo(() => new Set(state.favorites), [state.favorites]);

  const storeSnapRef = useRef<UserStateSnapshot>({
    state,
    ready,
    saving,
    error,
    favorites,
    selectedPlaylist,
  });
  const storeListenersRef = useRef<Set<() => void>>(new Set());
  useEffect(() => {
    storeSnapRef.current = {
      state,
      ready,
      saving,
      error,
      favorites,
      selectedPlaylist,
    };
    for (const listener of storeListenersRef.current) listener();
  }, [state, ready, saving, error, favorites, selectedPlaylist]);

  const storeApi = useMemo<UserStateStoreApi>(
    () => ({
      subscribe: (listener) => {
        storeListenersRef.current.add(listener);
        return () => {
          storeListenersRef.current.delete(listener);
        };
      },
      getSnapshot: () => storeSnapRef.current,
    }),
    [],
  );

  const trackRowListenersRef = useRef<Set<() => void>>(new Set());
  const trackRowSnapRef = useRef<{
    favorites: Set<string>;
    playCounts: Readonly<Record<string, number>>;
    excludedAlbums: Set<string>;
    excludedTracks: Set<string>;
  }>({
    favorites: new Set(),
    playCounts: {},
    excludedAlbums: new Set(),
    excludedTracks: new Set(),
  });
  const trackRowActionsRef = useRef({ toggleFavorite, toggleShuffleExcludedTrack });
  useEffect(() => {
    trackRowActionsRef.current = { toggleFavorite, toggleShuffleExcludedTrack };
  }, [toggleFavorite, toggleShuffleExcludedTrack]);
  useEffect(() => {
    trackRowSnapRef.current = {
      favorites,
      playCounts: state.trackPlayCounts || {},
      excludedAlbums: new Set(state.shuffleExcludedAlbumIds),
      excludedTracks: new Set(state.shuffleExcludedTrackRelPaths),
    };
    for (const listener of trackRowListenersRef.current) listener();
  }, [
    favorites,
    state.trackPlayCounts,
    state.shuffleExcludedAlbumIds,
    state.shuffleExcludedTrackRelPaths,
  ]);
  const trackRowStore = useMemo<TrackRowUserStore>(
    () => ({
      subscribe: (listener) => {
        trackRowListenersRef.current.add(listener);
        return () => {
          trackRowListenersRef.current.delete(listener);
        };
      },
      isFavorite: (relPath) =>
        isFavoriteRelPath(trackRowSnapRef.current.favorites, relPath),
      getTrackPlayCount: (relPath) =>
        trackRowSnapRef.current.playCounts[relPath] ?? 0,
      isShuffleExcludedTrack: (relPath) =>
        trackRowSnapRef.current.excludedTracks.has(relPath),
      isAlbumShuffleExcluded: (track) =>
        isTrackAlbumShuffleExcluded(track, trackRowSnapRef.current.excludedAlbums),
      toggleFavorite: (relPath) =>
        trackRowActionsRef.current.toggleFavorite(relPath),
      toggleShuffleExcludedTrack: (relPath) =>
        trackRowActionsRef.current.toggleShuffleExcludedTrack(relPath),
    }),
    []
  );

  const isFavorite = useCallback(
    (relPath: string) => isFavoriteRelPath(favorites, relPath),
    [favorites],
  );

  const actions = useMemo<UserStateActions>(
    () => ({
      setSelectedPlaylist,
      toggleFavorite,
      isFavorite,
      pushRecent,
      getTrackPlayCount,
      incrementTrackPlayCount,
      setQueueSnapshot,
      enqueueQueuePatch,
      flushUserStateNow,
      updateSettings,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addTrackToPlaylist,
      removeTrackFromPlaylist,
      saveQueueAsPlaylist,
      rehydrateTrackListsFromLibrary,
      toggleShuffleExcludedAlbum,
      toggleShuffleExcludedTrack,
      setShuffleTracksExcludedBulk,
      rehydrateShuffleExclusionsFromIndex,
      stripUserStateForRelPaths,
      syncUserStateFromServer,
      savePlectrBest,
    }),
    [
      addTrackToPlaylist,
      createPlaylist,
      deletePlaylist,
      enqueueQueuePatch,
      flushUserStateNow,
      getTrackPlayCount,
      incrementTrackPlayCount,
      isFavorite,
      pushRecent,
      rehydrateShuffleExclusionsFromIndex,
      rehydrateTrackListsFromLibrary,
      removeTrackFromPlaylist,
      renamePlaylist,
      savePlectrBest,
      saveQueueAsPlaylist,
      setQueueSnapshot,
      setShuffleTracksExcludedBulk,
      toggleFavorite,
      toggleShuffleExcludedAlbum,
      toggleShuffleExcludedTrack,
      stripUserStateForRelPaths,
      syncUserStateFromServer,
      updateSettings,
    ],
  );

  return (
    <UserStateStoreContext.Provider value={storeApi}>
      <UserStateActionsContext.Provider value={actions}>
        <TrackRowUserContext.Provider value={trackRowStore}>
          {children}
        </TrackRowUserContext.Provider>
      </UserStateActionsContext.Provider>
    </UserStateStoreContext.Provider>
  );
}

export function useUserStateActions() {
  const actions = useContext(UserStateActionsContext);
  if (!actions) throw new Error("useUserStateActions");
  return actions;
}

/** Selector granulare: ri-render solo quando il valore selezionato cambia. */
export function useUserStateSelector<T>(selector: (snap: UserStateSnapshot) => T): T {
  const store = useContext(UserStateStoreContext);
  if (!store) throw new Error("useUserStateSelector");
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  return useSyncExternalStore(
    store.subscribe,
    () => selectorRef.current(store.getSnapshot()),
    () => selectorRef.current(store.getSnapshot()),
  );
}

/** API compatibile: espone tutto lo snapshot + azioni. */
export function useUserState(): UserStateContextValue {
  const snap = useUserStateSelector((s) => s);
  const actions = useUserStateActions();
  return { ...snap, ...actions };
}

/** Selector: stato idratazione / errori sync. */
export function useUserStateStatus() {
  const ready = useUserStateSelector((s) => s.ready);
  const saving = useUserStateSelector((s) => s.saving);
  const error = useUserStateSelector((s) => s.error);
  return { ready, saving, error };
}

/** Selector: solo impostazioni utente (riduce re-render rispetto a useUserState). */
export function useUserSettingsSlice() {
  const settings = useUserStateSelector((s) => s.state.settings);
  const { updateSettings } = useUserStateActions();
  return useMemo(
    () => ({ settings, updateSettings }),
    [settings, updateSettings],
  );
}

/** Selector: favorites + playlists. */
export function useUserCollectionsSlice() {
  const favorites = useUserStateSelector((s) => s.state.favorites);
  const playlists = useUserStateSelector((s) => s.state.playlists);
  const { toggleFavorite } = useUserStateActions();
  return useMemo(
    () => ({
      favorites,
      playlists,
      toggleFavorite,
    }),
    [favorites, playlists, toggleFavorite],
  );
}

/** Selector: esclusioni shuffle + azioni correlate. */
export function useUserShuffleSlice() {
  const shuffleExcludedAlbumIds = useUserStateSelector(
    (s) => s.state.shuffleExcludedAlbumIds,
  );
  const shuffleExcludedTrackRelPaths = useUserStateSelector(
    (s) => s.state.shuffleExcludedTrackRelPaths,
  );
  const {
    toggleShuffleExcludedAlbum,
    toggleShuffleExcludedTrack,
    setShuffleTracksExcludedBulk,
    rehydrateShuffleExclusionsFromIndex,
  } = useUserStateActions();
  return useMemo(
    () => ({
      shuffleExcludedAlbumIds,
      shuffleExcludedTrackRelPaths,
      toggleShuffleExcludedAlbum,
      toggleShuffleExcludedTrack,
      setShuffleTracksExcludedBulk,
      rehydrateShuffleExclusionsFromIndex,
    }),
    [
      shuffleExcludedAlbumIds,
      shuffleExcludedTrackRelPaths,
      toggleShuffleExcludedAlbum,
      toggleShuffleExcludedTrack,
      setShuffleTracksExcludedBulk,
      rehydrateShuffleExclusionsFromIndex,
    ],
  );
}

/** Selector: playlist + operazioni CRUD. */
export function useUserPlaylistsSlice() {
  const playlists = useUserStateSelector((s) => s.state.playlists);
  const selectedPlaylist = useUserStateSelector((s) => s.selectedPlaylist);
  const {
    setSelectedPlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    saveQueueAsPlaylist,
  } = useUserStateActions();
  return useMemo(
    () => ({
      playlists,
      selectedPlaylist,
      setSelectedPlaylist,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addTrackToPlaylist,
      removeTrackFromPlaylist,
      saveQueueAsPlaylist,
    }),
    [
      playlists,
      selectedPlaylist,
      setSelectedPlaylist,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addTrackToPlaylist,
      removeTrackFromPlaylist,
      saveQueueAsPlaylist,
    ],
  );
}

/**
 * Sottoscrizione granulare per una riga brano: ri-renderizza solo quando
 * cambiano preferito / conteggio ascolti / esclusioni shuffle di quel brano.
 */
export function useTrackRowUserState(track: EnrichedTrack) {
  const store = useContext(TrackRowUserContext);
  if (!store) throw new Error("useTrackRowUserState");
  const relPath = track.relPath;
  const fav = useSyncExternalStore(
    store.subscribe,
    () => store.isFavorite(relPath)
  );
  const playCount = useSyncExternalStore(
    store.subscribe,
    () => store.getTrackPlayCount(relPath)
  );
  const trackShuffleExcluded = useSyncExternalStore(
    store.subscribe,
    () => store.isShuffleExcludedTrack(relPath)
  );
  const albumShuffleExcluded = useSyncExternalStore(store.subscribe, () =>
    store.isAlbumShuffleExcluded(track)
  );
  return {
    fav,
    playCount,
    trackShuffleExcluded,
    albumShuffleExcluded,
    toggleFavorite: store.toggleFavorite,
    toggleShuffleExcludedTrack: store.toggleShuffleExcludedTrack,
  };
}
