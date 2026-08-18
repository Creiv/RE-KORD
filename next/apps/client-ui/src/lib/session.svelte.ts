import {
  getSelectedAccountId,
  setSelectedAccountId,
} from "./account";
import {
  api,
  type Album,
  type Artist,
  type LibraryStats,
  type MachineAccess,
  type Playlist,
  type ScanReport,
  type Track,
} from "./api";
import { getServerBaseUrl, setServerBaseUrl } from "./config";
import { i18n, t } from "./i18n.svelte";
import { player } from "./player";
import { describeError, toasts } from "./toasts.svelte";
import { watchOtherTabs } from "./tabSync";
import { normalizeCustomTheme } from "./themeCatalog";
import {
  applyTheme,
  forgetTracksInPrefs,
  loadUserPrefs,
  migratePrefsToRelPaths,
  normalizeGlassOpacity,
  normalizeLocale,
  normalizeTheme,
  normalizeVisualizerMode,
  patchUserPrefs,
  setUserPrefsChangeListener,
  type CrossfadeSec,
} from "./userPrefs";

export type ViewId =
  | "dashboard"
  | "studio"
  | "library"
  | "plectr"
  | "favorites"
  | "playlists"
  | "queue"
  | "recent"
  | "statistics"
  | "achievements"
  | "settings";
export type LibraryLevel = "artists" | "artist" | "album" | "search";
export type LibraryBrowse = "artists" | "genres" | "moods" | "nebula";
export type StudioPane = "listen" | "catalog" | "download" | "meta" | "covers";
export type EditDialog = "none" | "track" | "album" | "cover";

/** Resume events arrive in bursts (visibilitychange + pageshow + online). */
const RECOVERY_DEBOUNCE_MS = 450;
/** Below this, a foreground return reuses what the UI already has. */
const RECOVERY_MIN_GAP_MS = 15_000;

class ClientSession {
  view = $state<ViewId>("dashboard");
  libraryLevel = $state<LibraryLevel>("artists");
  libraryBrowse = $state<LibraryBrowse>("artists");
  studioPane = $state<StudioPane>("listen");
  selectedGenre = $state<string | null>(null);
  moodFilterIds = $state<string[]>([]);
  moodMatchAll = $state(false);
  /** Cache catalogo per filtri mood / mix dashboard. */
  catalogTracks = $state<Track[]>([]);
  /** Delta cursor for `library/changes`; null forces a full page-through. */
  catalogRevision: string | null = null;
  moodPrefsTick = $state(0);

  artists = $state<Artist[]>([]);
  albums = $state<Album[]>([]);
  allAlbums = $state<Album[]>([]);
  tracks = $state<Track[]>([]);
  favorites = $state<Track[]>([]);
  favoriteIds = $state<Set<number>>(new Set());
  playlists = $state<Playlist[]>([]);
  activePlaylistId = $state<string | null>(null);
  playlistTracks = $state<Track[]>([]);
  stats = $state<LibraryStats | null>(null);
  /**
   * Whether this client may run host-level operations (library path, scans,
   * credentials, restores, tunnel). Null until known; treated as allowed so the
   * UI is not locked while loading.
   */
  machineAccess = $state<MachineAccess | null>(null);

  selectedArtist = $state<Artist | null>(null);
  selectedAlbum = $state<Album | null>(null);
  editDialog = $state<EditDialog>("none");
  editTrack = $state<Track | null>(null);

  query = $state("");
  serverUrl = $state(getServerBaseUrl());
  status = $state("");
  /** Account this session is working with; kept to spot changes from other tabs. */
  activeAccountId = $state<string | null>(null);
  /**
   * Connection-level failure shown as a persistent banner. One-off operation
   * errors go to toasts instead: a banner that never clears itself would keep
   * shouting about a search that failed ten minutes ago.
   */
  error = $state("");
  newPlaylistName = $state("");
  queuePlaylistName = $state("");
  crossfadeSec = $state<CrossfadeSec>(loadUserPrefs().crossfadeSec);
  /** Bumps on player state changes (track/queue/playing) — drives list/UI refresh. */
  tick = $state(0);
  /** Bumps on timeupdate only — timeline/dock; must not refresh TrackList. */
  progressTick = $state(0);
  /** Remount Studio on sidebar re-click (clears local catalog drill-down). */
  studioHomeTick = $state(0);
  /** Remount Settings on sidebar re-click (restores default tab). */
  settingsHomeTick = $state(0);
  /** Remount Dashboard on sidebar re-click (fresh radio picks; player untouched). */
  dashboardHomeTick = $state(0);

  /** Optimistic: unknown rights must not lock the UI on a slow hub. */
  readonly canManageMachine = $derived(
    this.machineAccess?.canManageMachine !== false,
  );

  /** Where to send the user for host-level settings. */
  readonly hubPanelUrl = $derived.by(() => {
    const base = this.serverUrl.trim().replace(/\/+$/, "");
    if (base) return `${base}/admin`;
    return typeof location === "undefined" ? "/admin" : `${location.origin}/admin`;
  });

  readonly current = $derived.by(() => {
    this.tick;
    return player.current;
  });
  readonly playing = $derived.by(() => {
    this.tick;
    return player.playing;
  });
  readonly currentTime = $derived.by(() => {
    this.progressTick;
    this.tick;
    return player.currentTime;
  });
  readonly duration = $derived.by(() => {
    this.progressTick;
    this.tick;
    return player.duration;
  });
  readonly shuffle = $derived.by(() => {
    this.tick;
    return player.shuffle;
  });
  readonly repeat = $derived.by(() => {
    this.tick;
    return player.repeat;
  });
  readonly queue = $derived.by(() => {
    this.tick;
    return player.queue;
  });
  readonly currentIndex = $derived.by(() => {
    this.tick;
    return player.currentIndex;
  });
  readonly hasQueue = $derived.by(() => {
    this.tick;
    return player.queue.length > 0;
  });
  readonly sleepTimerEndsAt = $derived.by(() => {
    this.tick;
    return player.sleepTimerEndsAt;
  });
  readonly isFavoriteCurrent = $derived.by(() => {
    const c = this.current;
    return c ? this.favoriteIds.has(c.id) : false;
  });
  readonly isCurrentExcluded = $derived.by(() => {
    this.tick;
    const c = this.current;
    return c ? player.isTrackExcluded(c) : false;
  });
  readonly isCurrentAlbumExcluded = $derived.by(() => {
    this.tick;
    const c = this.current;
    return c?.album_id != null ? player.isAlbumExcluded(c.album_id) : false;
  });

  readonly playlistOptions = $derived(
    this.playlists.map((p) => ({ value: p.id, label: p.name })),
  );

  /** Topbar title: the navigation section only, never an album/artist/query. */
  readonly pageTitle = $derived(
    this.view ? t(`nav.${this.view}`) : t("nav.dashboard"),
  );


  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight = false;
  private pushAgain = false;
  private userStateDirty = false;
  /**
   * True when local edits touch appearance/settings (theme, glass, locale, …).
   * Play-count / recent / mood flushes must NOT push settings — empty localStorage
   * defaults (midnight) would wipe the account theme on the hub.
   */
  private settingsDirty = false;
  private suppressUserStatePush = false;
  private prefsListenerBound = false;
  /**
   * False until the first successful pull for the active account on this origin.
   * Blocks push of pristine localStorage defaults (new LAN/tunnel origin) over
   * server prefs that were set from localhost / another origin.
   */
  private userStateHydrated = false;
  /** Guards the foreground probe from piling on top of a running refresh. */
  private refreshing = false;
  private lastRefreshAt = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  private clearPendingUserStatePush() {
    this.userStateDirty = false;
    this.settingsDirty = false;
    this.pushAgain = false;
    if (this.pushTimer != null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  private ensurePrefsSync() {
    if (this.prefsListenerBound) return;
    this.prefsListenerBound = true;
    setUserPrefsChangeListener((_prefs, patch) => {
      if (this.suppressUserStatePush) return;
      this.userStateDirty = true;
      if (prefsPatchTouchesSettings(patch)) this.settingsDirty = true;
      this.pushUserStateDebounced();
    });
  }

  /** Re-apply theme/glass from the active account's local prefs (post account bind). */
  private hydrateThemeFromLocal() {
    const prefs = loadUserPrefs();
    applyTheme(prefs.theme, prefs.customTheme, {
      glassSurfaces: prefs.glassSurfaces,
      glassOpacity: prefs.glassOpacity,
    });
    this.crossfadeSec = prefs.crossfadeSec;
    player.applyCrossfadeSec(prefs.crossfadeSec);
    i18n.applySaved();
  }

  bindPlayer() {
    this.ensurePrefsSync();
    const flush = () => {
      void this.flushUserStatePush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    const unsub = player.subscribe(() => {
      this.tick += 1;
      this.crossfadeSec = player.crossfadeSec;
    });
    const unsubProgress = player.subscribeProgress(() => {
      this.progressTick += 1;
    });
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      unsub();
      unsubProgress();
    };
  }

  /** Parity legacy: cover mancante solo su album non-loose. */
  readonly albumsWithoutCover = $derived(
    this.allAlbums.filter((a) => !a.has_cover && !a.loose).length,
  );

  /**
   * Pull account prefs from the hub into localStorage + DOM.
   * Pass `{ skipFlush: true }` after theme import so a stale local customTheme
   * cannot overwrite the just-imported server state.
   */
  async pullUserState(opts?: { skipFlush?: boolean }) {
    this.ensurePrefsSync();
    // Only flush real edits from an already-hydrated session. A new origin
    // (LAN IP / Cloudflare tunnel) has empty localStorage → DEFAULTS; pushing
    // those before pull would wipe server prefs set from localhost.
    // Keep unsaved appearance edits if a settings flush might still be pending.
    const preserveLocalAppearance =
      this.userStateHydrated &&
      this.settingsDirty &&
      !opts?.skipFlush;
    if (
      this.userStateHydrated &&
      !opts?.skipFlush &&
      (this.userStateDirty || this.pushTimer != null)
    ) {
      await this.flushUserStatePush();
    } else if (!this.userStateHydrated || opts?.skipFlush) {
      this.clearPendingUserStatePush();
    }
    this.suppressUserStatePush = true;
    try {
      const remote = await api.getUserState();
      const local = loadUserPrefs();
      const settings = (remote.settings ?? {}) as Record<string, unknown>;
      const themeRaw = settings.theme;
      const crossfadeRaw =
        settings.crossfadeSec ?? settings.audioCrossfadeSec;
      const vizRaw = settings.visualizerMode ?? settings.vizMode;
      const localeRaw = settings.locale;

      const patch: Parameters<typeof patchUserPrefs>[0] = {
        playCounts: {
          ...local.playCounts,
          ...(remote.playCounts as Record<string, number>),
        },
        recentRelPaths: remote.recentRelPaths?.length
          ? remote.recentRelPaths
          : local.recentRelPaths,
        // Moods / excludes are personal per-account on the server — always
        // take the hub snapshot (including intentional empty lists). Merging
        // "only if remote non-empty" would resurrect stale localStorage blocks.
        trackMoods: {
          ...((remote.trackMoods as Record<string, string[]>) ?? {}),
        },
        excludedRelPaths: [...(remote.excludedRelPaths ?? [])],
        excludedAlbumIds: [...(remote.excludedAlbumIds ?? [])],
      };
      // Appearance: hub wins unless we still have unsaved local settings edits
      // (flush may have failed). Never invent midnight when the server omits theme.
      if (!preserveLocalAppearance) {
        if (typeof themeRaw === "string" && themeRaw.trim()) {
          patch.theme = normalizeTheme(themeRaw);
        }
        if (settings.customTheme && typeof settings.customTheme === "object") {
          patch.customTheme = normalizeCustomTheme(
            settings.customTheme as Record<string, unknown>,
          );
        }
        if (typeof settings.glassSurfaces === "boolean") {
          patch.glassSurfaces = settings.glassSurfaces;
        }
        if (
          settings.glassOpacity != null &&
          Number.isFinite(Number(settings.glassOpacity))
        ) {
          patch.glassOpacity = normalizeGlassOpacity(settings.glassOpacity);
        }
        if (localeRaw === "en" || localeRaw === "it") {
          patch.locale = normalizeLocale(localeRaw);
        }
        if (
          crossfadeRaw === 0 ||
          crossfadeRaw === 3 ||
          crossfadeRaw === 5 ||
          crossfadeRaw === 8 ||
          crossfadeRaw === 12
        ) {
          patch.crossfadeSec = (
            crossfadeRaw === 8 || crossfadeRaw === 12 ? 5 : crossfadeRaw
          ) as CrossfadeSec;
        }
        if (typeof vizRaw === "string" && vizRaw.trim()) {
          patch.visualizerMode = normalizeVisualizerMode(vizRaw);
        }
      }
      const merged = patchUserPrefs(patch);
      if (patch.crossfadeSec != null) {
        this.crossfadeSec = merged.crossfadeSec;
        player.applyCrossfadeSec(merged.crossfadeSec);
      }
      applyTheme(merged.theme, merged.customTheme, {
        glassSurfaces: merged.glassSurfaces,
        glassOpacity: merged.glassOpacity,
      });
      i18n.applySaved();
      player.reloadExclusionsFromPrefs();
      this.pendingLegacyQueue = settings.legacyQueue as
        | { relPaths?: string[]; currentIndex?: number }
        | null;
      this.moodPrefsTick += 1;
      this.userStateHydrated = true;
      if (!preserveLocalAppearance) this.settingsDirty = false;
    } catch {
      /* server may be older / offline — keep unhydrated so we never push defaults */
    } finally {
      this.suppressUserStatePush = false;
    }
  }

  private pendingLegacyQueue: {
    relPaths?: string[];
    currentIndex?: number;
  } | null = null;

  private applyPendingLegacyQueue() {
    const q = this.pendingLegacyQueue;
    this.pendingLegacyQueue = null;
    if (!q?.relPaths?.length || !this.catalogTracks.length) return;
    // One-shot cold restore only — refreshAll must not re-hydrate mid-playback.
    player.hydrateQueueFromRelPaths(
      q.relPaths.filter((p): p is string => typeof p === "string" && !!p),
      typeof q.currentIndex === "number" ? q.currentIndex : 0,
      this.catalogTracks,
    );
  }

  pushUserStateDebounced() {
    this.ensurePrefsSync();
    if (this.suppressUserStatePush) return;
    // New origin: wait for pull before any push (defaults must not win).
    if (!this.userStateHydrated) return;
    if (this.pushTimer != null) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushUserStatePush();
    }, 350);
  }

  async flushUserStatePush() {
    if (this.pushTimer != null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.suppressUserStatePush) return;
    if (!this.userStateHydrated) return;
    if (!this.userStateDirty && !this.pushAgain) return;
    if (this.pushInFlight) {
      this.pushAgain = true;
      return;
    }
    this.pushInFlight = true;
    const includeSettings = this.settingsDirty;
    try {
      const p = loadUserPrefs();
      const body: Record<string, unknown> = {
        playCounts: p.playCounts,
        recentRelPaths: p.recentRelPaths,
        trackMoods: p.trackMoods,
        excludedRelPaths: p.excludedRelPaths,
        excludedAlbumIds: p.excludedAlbumIds,
      };
      // Only push settings when the user actually edited them. Otherwise a
      // playCounts flush from a fresh origin (midnight defaults) wipes theme.
      if (includeSettings) {
        body.settings = {
          crossfadeSec: p.crossfadeSec,
          theme: p.theme,
          customTheme: p.customTheme,
          glassSurfaces: p.glassSurfaces,
          glassOpacity: p.glassOpacity,
          locale: p.locale,
          visualizerMode: p.visualizerMode,
        };
      }
      await api.patchUserState(body);
      this.userStateDirty = false;
      if (includeSettings) this.settingsDirty = false;
    } catch {
      /* keep dirty so a later flush/retry can sync */
    } finally {
      this.pushInFlight = false;
      if (this.pushAgain) {
        this.pushAgain = false;
        void this.flushUserStatePush();
      }
    }
  }

  /**
   * Trigger a full disk rescan and wait until the hub reports idle.
   * Removes ghost artists/albums whose folders were deleted on disk.
   */
  async rescanLibrary(maxWaitMs = 180_000): Promise<ScanReport | null> {
    let report: ScanReport | null = null;
    try {
      report = await api.scanLibrary();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Concurrent scan (startup autoscan / previous reload): wait it out.
      if (!/already in progress|Conflict/i.test(msg)) throw e;
    }
    const started = Date.now();
    let delay = 400;
    while (Date.now() - started < maxWaitMs) {
      const stats = await api.stats();
      this.stats = stats;
      if (!stats.scanning) return report;
      this.status = "indexing";
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.25), 2000);
    }
    return report;
  }

  /** What the sync toast says once the hub is done. */
  private syncSummary(report: ScanReport | null, scanned: boolean): string {
    if (!scanned) return t("toast.syncPulled");
    const tracks = this.stats?.track_count ?? this.catalogTracks.length;
    const detail: string[] = [];
    if (report && report.indexedTracks > 0) {
      detail.push(t("toast.syncAdded", { count: report.indexedTracks }));
    }
    if (report && report.removedTracks > 0) {
      detail.push(t("toast.syncRemoved", { count: report.removedTracks }));
    }
    return detail.length
      ? t("toast.syncDoneDetail", { tracks, detail: detail.join(", ") })
      : t("toast.syncDone", { tracks });
  }

  /**
   * Refresh hub data into the UI.
   * Pass `{ rescan: true }` from TopBar Reload so the catalog matches disk
   * (legacy sync reconciles the filesystem index; next must scan SQLite).
   */
  async refreshAll(opts?: { rescan?: boolean; notify?: boolean }) {
    this.status = "…";
    this.error = "";
    this.refreshing = true;
    // One toast per sync, reused by the retry loops so they cannot pile up.
    const job = opts?.notify ? toasts.busy(t("toast.syncBusy"), "library-sync") : null;
    let scanned = false;
    let report: ScanReport | null = null;
    try {
      await api.health();
      // Scanning is a machine operation: remote clients just re-read the hub.
      if (opts?.rescan && this.canManageMachine) {
        this.status = "indexing";
        job?.update(t("toast.syncScanning"));
        report = await this.rescanLibrary();
        scanned = true;
      }
      await Promise.all([
        this.loadStats(),
        this.loadMachineAccess(),
        this.loadArtists(),
        this.loadAllAlbums(),
        this.loadFavorites(),
        this.loadPlaylists(),
        // Delta sync on refresh; only the first load pages the whole catalog.
        this.syncCatalogDelta(),
        this.pullUserState(),
      ]);
      // Remap prefs that used SQLite ids before the last catalog wipe/rescan.
      if (this.catalogTracks.length) {
        migratePrefsToRelPaths(this.catalogTracks);
        player.reloadExclusionsFromPrefs();
        this.applyPendingLegacyQueue();
      }
      this.status = this.stats?.scanning ? "indexing" : "online";
      job?.done(this.syncSummary(report, scanned));
    } catch (e) {
      this.status = "offline";
      // With a toast up, the banner would say the same thing twice.
      if (job) job.done(t("toast.syncFailed", { error: describeError(e) }), "error");
      else this.error = describeError(e);
    } finally {
      this.refreshing = false;
      this.lastRefreshAt = Date.now();
    }
  }

  /** Soft switch: no full page reload — reload selection, prefs, favorites/playlists. */
  async switchAccount(accountId: string) {
    if (!accountId || accountId === getSelectedAccountId()) return;
    await this.releaseAccount();
    setSelectedAccountId(accountId);
    this.applyAccountLocally(accountId);
    await this.refreshAll();
  }

  /** Persist the outgoing account before the binding changes. */
  private async releaseAccount() {
    if (
      this.userStateHydrated &&
      (this.userStateDirty || this.pushTimer != null)
    ) {
      await this.flushUserStatePush();
    }
    // Next account must pull before any push (empty local key ≠ server defaults).
    this.userStateHydrated = false;
    this.clearPendingUserStatePush();
  }

  /** Repaint prefs, theme and library selection for the account now in charge. */
  private applyAccountLocally(accountId: string) {
    this.activeAccountId = accountId;
    this.suppressUserStatePush = true;
    try {
      const prefs = loadUserPrefs(accountId);
      applyTheme(prefs.theme, prefs.customTheme, {
        glassSurfaces: prefs.glassSurfaces,
        glassOpacity: prefs.glassOpacity,
      });
      this.crossfadeSec = prefs.crossfadeSec;
      // Do not patchUserPrefs here — empty local defaults would mark dirty and
      // flush over the server on the subsequent pullUserState.
      player.applyCrossfadeSec(prefs.crossfadeSec);
      player.reloadExclusionsFromPrefs();
      this.activePlaylistId = null;
      this.playlistTracks = [];
      this.selectedArtist = null;
      this.selectedAlbum = null;
      this.libraryLevel = "artists";
      this.moodPrefsTick += 1;
      i18n.applySaved();
    } finally {
      this.suppressUserStatePush = false;
    }
  }

  /**
   * Another tab bound the client to a different account: follow it without
   * writing the key back, otherwise the two tabs would ping-pong.
   */
  private async followAccountFromTab(accountId: string) {
    if (!accountId || accountId === this.activeAccountId) return;
    await this.releaseAccount();
    this.applyAccountLocally(accountId);
    await this.refreshAll();
    const account = await this.accountLabel(accountId);
    toasts.info(t("toast.accountFromTab", { account }));
  }

  /** Re-read prefs a sibling tab just rewrote for the account we are on. */
  private followPrefsFromTab(accountId: string) {
    if (accountId !== (this.activeAccountId || "default")) return;
    this.hydrateThemeFromLocal();
    player.reloadExclusionsFromPrefs();
    this.moodPrefsTick += 1;
    this.tick += 1;
  }

  private async accountLabel(accountId: string): Promise<string> {
    try {
      const data = await api.accounts();
      return data.accounts.find((a) => a.id === accountId)?.name || accountId;
    } catch {
      return accountId;
    }
  }

  /**
   * Sibling tabs and connectivity. Kept apart from `bindPlayer` because the
   * listeners here answer "is the hub still there?", not "what is playing".
   */
  bindWindow() {
    const stopTabs = watchOtherTabs({
      onAccount: (id) => void this.followAccountFromTab(id),
      onPrefs: (id) => this.followPrefsFromTab(id),
    });
    const stopConnection = this.watchConnection();
    return () => {
      stopTabs();
      stopConnection();
    };
  }

  /**
   * Coming back from the background (or from a dead network) with a stale UI is
   * the common case on phones: probe the hub and pull the delta, quietly unless
   * we were actually offline.
   */
  private watchConnection() {
    if (typeof window === "undefined") return () => {};
    const schedule = () => {
      if (this.recoveryTimer != null) return;
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        void this.recoverNow();
      }, RECOVERY_DEBOUNCE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    const onOffline = () => {
      this.status = "offline";
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("online", schedule);
    window.addEventListener("offline", onOffline);
    return () => {
      if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("online", schedule);
      window.removeEventListener("offline", onOffline);
    };
  }

  private async recoverNow() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.refreshing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.status = "offline";
      return;
    }
    const wasDown = this.status === "offline" || Boolean(this.error);
    // A quick tab switch should not re-pull everything.
    if (!wasDown && Date.now() - this.lastRefreshAt < RECOVERY_MIN_GAP_MS) return;
    await this.refreshAll();
    if (wasDown && this.status !== "offline") toasts.ok(t("toast.backOnline"));
  }

  /**
   * Boot: wait for the hub (and optional background first-scan) so the UI
   * does not stick on an empty library / missing covers after a cold start.
   * Session queue restore is always on (queue + currentIndex only).
   */
  async bootstrap(maxWaitMs = 90_000) {
    this.ensurePrefsSync();
    // OS "like" button → favourites, which only this store can reach.
    player.setFavoriteToggle(() => void this.toggleFavoriteCurrent());
    try {
      await api.ensureAccountSession();
    } catch {
      /* offline / first paint — retry via refreshAll */
    }
    // Account id may have been bound just now — re-paint from that key before pull.
    this.activeAccountId = getSelectedAccountId();
    this.hydrateThemeFromLocal();
    const started = Date.now();
    let delay = 400;
    while (Date.now() - started < maxWaitMs) {
      await this.refreshAll();
      if (this.status === "offline") {
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), 3000);
        continue;
      }
      if (this.stats?.scanning) {
        this.status = "indexing";
        this.error = "";
        await sleep(800);
        delay = 400;
        continue;
      }
      // Online and idle: done (even if library is intentionally empty).
      this.tryRestoreListeningSession();
      return;
    }
    this.tryRestoreListeningSession();
  }

  /** Always restore persisted queue + index (never gated by settings). */
  tryRestoreListeningSession() {
    player.restorePersistedQueue(this.catalogTracks);
  }

  async loadStats() {
    this.stats = await api.stats();
  }

  /** Host-level rights for this client; failures leave the UI unlocked. */
  async loadMachineAccess() {
    try {
      this.machineAccess = await api.machineAccess();
    } catch {
      this.machineAccess = null;
    }
  }

  async loadArtists() {
    this.artists = await api.artists();
  }

  async loadAllAlbums() {
    this.allAlbums = await api.albums();
  }

  /**
   * Page through the personal library instead of one capped request, so large
   * libraries are complete (the old 2000 cap silently truncated them) and the
   * first page paints while the rest streams in.
   */
  async loadCatalogTracks() {
    const pageSize = 1000;
    const first = await api.tracksPage(pageSize, 0);
    let items = first.items.slice();
    this.catalogTracks = items;
    this.catalogRevision = null;
    for (let offset = pageSize; offset < first.total; offset += pageSize) {
      const page = await api.tracksPage(pageSize, offset);
      if (!page.items.length) break;
      items = items.concat(page.items);
      this.catalogTracks = items;
    }
    try {
      const cursor = await api.libraryChanges(null);
      this.catalogRevision = cursor.revision ?? null;
    } catch {
      /* delta sync is an optimisation only */
    }
  }

  /**
   * Apply only what changed since the last full load. Falls back to a full
   * page-through when the hub reports the delta is too large.
   */
  async syncCatalogDelta(): Promise<boolean> {
    if (!this.catalogTracks.length || !this.catalogRevision) {
      await this.loadCatalogTracks();
      return true;
    }
    let changes;
    try {
      changes = await api.libraryChanges(this.catalogRevision);
    } catch {
      return false;
    }
    if (changes.full) {
      await this.loadCatalogTracks();
      return true;
    }
    if (!changes.updated.length && !changes.removed.length) {
      this.catalogRevision = changes.revision ?? this.catalogRevision;
      return false;
    }
    const byPath = new Map(
      this.catalogTracks.map((track) => [track.rel_path, track]),
    );
    for (const rel of changes.removed) byPath.delete(rel);
    for (const track of changes.updated) byPath.set(track.rel_path, track);
    this.catalogTracks = [...byPath.values()].sort(
      (a, b) =>
        a.artist_name.localeCompare(b.artist_name) ||
        a.album_name.localeCompare(b.album_name) ||
        (a.track_number ?? 0) - (b.track_number ?? 0) ||
        a.title.localeCompare(b.title),
    );
    this.catalogRevision = changes.revision ?? this.catalogRevision;
    return true;
  }

  async ensureCatalogTracks() {
    if (this.catalogTracks.length) return this.catalogTracks;
    await this.loadCatalogTracks();
    return this.catalogTracks;
  }

  bumpMoodPrefs() {
    this.moodPrefsTick += 1;
    this.tick += 1;
  }

  /**
   * Files just left the disk: take them out of the queue, the preferences and
   * the lists on screen, then re-read the hub so albums and artists left empty
   * disappear too.
   */
  async forgetDeletedTracks(relPaths: string[], trackIds: number[] = []) {
    const gone = new Set(relPaths.filter(Boolean));
    if (!gone.size) return;
    for (const rel of gone) player.removeFromQueueByRelPath(rel);
    forgetTracksInPrefs({ relPaths: [...gone], trackIds });
    player.reloadExclusionsFromPrefs();
    const keep = (t: Track) => !gone.has(t.rel_path);
    this.tracks = this.tracks.filter(keep);
    this.catalogTracks = this.catalogTracks.filter(keep);
    this.favorites = this.favorites.filter(keep);
    this.bumpMoodPrefs();
    await this.refreshAll();
  }

  openTrackEdit(track: Track) {
    this.editTrack = track;
    this.editDialog = "track";
  }

  openAlbumEdit() {
    if (!this.selectedAlbum) return;
    this.editDialog = "album";
  }

  openCoverEdit() {
    if (!this.selectedAlbum) return;
    this.editDialog = "cover";
  }

  async openCoverEditForTrack(track: Track) {
    if (track.album_id == null) return;
    try {
      const album = await api.album(track.album_id);
      this.selectedAlbum = album;
      this.editDialog = "cover";
    } catch (e) {
      toasts.fail(e);
    }
  }

  closeEdit() {
    this.editDialog = "none";
    this.editTrack = null;
  }

  async openArtist(artist: Artist) {
    this.view = "library";
    this.libraryLevel = "artist";
    this.selectedArtist = artist;
    this.selectedAlbum = null;
    this.tracks = [];
    this.albums = [];
    try {
      const albums = await api.artistAlbums(artist.id);
      this.albums = albums.length
        ? albums.slice()
        : this.allAlbums.filter((a) => a.artist_id === artist.id);
    } catch (e) {
      this.albums = this.allAlbums.filter((a) => a.artist_id === artist.id);
      toasts.fail(e);
    }
  }

  async openAlbum(album: Album) {
    this.view = "library";
    this.libraryLevel = "album";
    this.selectedAlbum = album;
    this.tracks = [];
    try {
      const tracks = await api.albumTracks(album.id);
      this.tracks = Array.isArray(tracks) ? tracks.slice() : [];
      this.tick += 1;
    } catch (e) {
      this.tracks = [];
      toasts.fail(e);
    }
  }

  async openLibraryForTrack(track: Track) {
    try {
      if (track.artist_id != null) {
        const artist = await api.artist(track.artist_id);
        await this.openArtist(artist);
      }
      if (track.album_id != null) {
        const album = await api.album(track.album_id);
        await this.openAlbum(album);
      }
    } catch (e) {
      toasts.fail(e);
    }
  }

  async openLibraryArtist(track: Track) {
    if (track.artist_id == null) return;
    try {
      const artist = await api.artist(track.artist_id);
      await this.openArtist(artist);
    } catch (e) {
      toasts.fail(e);
    }
  }

  async backLibrary() {
    if (this.libraryLevel === "album" && this.selectedArtist) {
      this.selectedAlbum = null;
      this.tracks = [];
      this.libraryLevel = "artist";
      this.albums = await api.artistAlbums(this.selectedArtist.id);
      return;
    }
    if (this.libraryLevel === "search") {
      this.query = "";
      this.libraryLevel = "artists";
      this.tracks = [];
      await this.loadArtists();
      return;
    }
    this.libraryLevel = "artists";
    this.selectedArtist = null;
    this.selectedAlbum = null;
    this.albums = [];
    this.tracks = [];
    await this.loadArtists();
  }

  async searchLibrary() {
    const q = this.query.trim();
    this.view = "library";
    if (!q) {
      this.libraryLevel = "artists";
      this.tracks = [];
      await this.loadArtists();
      return;
    }
    this.libraryLevel = "search";
    this.selectedArtist = null;
    this.selectedAlbum = null;
    try {
      this.tracks = await api.search(q);
    } catch (e) {
      toasts.fail(e);
    }
  }

  focusSearch() {
    this.view = "library";
    if (this.query.trim()) {
      void this.searchLibrary();
    } else {
      this.libraryLevel = "search";
      this.tracks = [];
    }
  }

  matchArtists(q: string) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return this.artists.filter((a) => a.name.toLowerCase().includes(n));
  }

  matchAlbums(q: string) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return this.allAlbums.filter(
      (a) => a.name.toLowerCase().includes(n) || a.artist_name.toLowerCase().includes(n),
    );
  }

  async loadFavorites() {
    this.favorites = await api.favorites();
    this.favoriteIds = new Set(this.favorites.map((track) => track.id));
  }

  async loadPlaylists() {
    this.playlists = await api.playlists();
  }

  async openPlaylist(id: string) {
    this.activePlaylistId = id;
    const data = await api.playlistTracks(id);
    this.playlistTracks = data.tracks;
  }

  saveServer() {
    setServerBaseUrl(this.serverUrl);
    void this.refreshAll();
  }

  setCrossfade(sec: CrossfadeSec) {
    player.setCrossfadeSec(sec);
    this.crossfadeSec = sec;
  }

  async toggleFavorite(track: Track) {
    if (this.favoriteIds.has(track.id)) await api.removeFavorite(track.id);
    else await api.addFavorite(track.id);
    await this.loadFavorites();
  }

  async toggleFavoriteCurrent() {
    const track = this.current;
    if (!track) return;
    await this.toggleFavorite(track);
  }

  toggleExcludeCurrent() {
    const track = this.current;
    if (!track) return;
    player.toggleExcludeTrack(track);
  }

  /** Name for messages; the id is never something to show the user. */
  private playlistName(id: string): string {
    return this.playlists.find((p) => p.id === id)?.name ?? "";
  }

  async createPlaylist() {
    const name = this.newPlaylistName.trim();
    if (!name) return;
    const pl = await api.createPlaylist(name);
    this.newPlaylistName = "";
    await this.loadPlaylists();
    await this.openPlaylist(pl.id);
    toasts.ok(t("toast.playlistCreated", { playlist: name }));
  }

  async renamePlaylist(id: string, name: string) {
    await api.renamePlaylist(id, name);
    await this.loadPlaylists();
  }

  async deletePlaylist(id: string) {
    const name = this.playlistName(id);
    await api.deletePlaylist(id);
    if (this.activePlaylistId === id) {
      this.activePlaylistId = null;
      this.playlistTracks = [];
    }
    await this.loadPlaylists();
    toasts.ok(t("toast.playlistDeleted", { playlist: name }));
  }

  async addToPlaylist(playlistId: string, trackId: number) {
    const name = this.playlistName(playlistId);
    await api.addToPlaylist(playlistId, trackId);
    await this.loadPlaylists();
    if (this.activePlaylistId === playlistId) await this.openPlaylist(playlistId);
    toasts.ok(t("toast.playlistAdded", { playlist: name }));
  }

  async addCurrentToPlaylist(playlistId: string) {
    const track = this.current;
    if (!track) return;
    await this.addToPlaylist(playlistId, track.id);
  }

  async removeFromPlaylist(playlistId: string, trackId: number) {
    const name = this.playlistName(playlistId);
    await api.removeFromPlaylist(playlistId, trackId);
    await this.loadPlaylists();
    if (this.activePlaylistId === playlistId) await this.openPlaylist(playlistId);
    toasts.ok(t("toast.playlistRemoved", { playlist: name }));
  }

  /** Optimistic reorder: the list moves at once, the hub confirms after. */
  async movePlaylistTrack(playlistId: string, from: number, to: number) {
    if (from === to || this.activePlaylistId !== playlistId) return;
    const before = this.playlistTracks;
    if (from < 0 || from >= before.length || to < 0 || to >= before.length) return;
    const next = before.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.playlistTracks = next;
    try {
      await api.reorderPlaylist(
        playlistId,
        next.map((track) => track.id),
      );
    } catch (e) {
      // Roll back so the shown order never lies about what the hub stored.
      if (this.activePlaylistId === playlistId) this.playlistTracks = before;
      toasts.fail(e);
    }
  }

  async saveQueueAsPlaylist() {
    const name = this.queuePlaylistName.trim() || "Coda salvata";
    const tracks = player.queue.length;
    const pl = await api.createPlaylist(name);
    for (const track of player.queue) {
      await api.addToPlaylist(pl.id, track.id);
    }
    this.queuePlaylistName = "";
    await this.loadPlaylists();
    this.view = "playlists";
    await this.openPlaylist(pl.id);
    toasts.ok(t("toast.queueSaved", { playlist: name, tracks }));
  }

  navigate(id: ViewId) {
    this.view = id;
    // Dashboard: no refreshAll — that pulled user-state / legacyQueue and could
    // stop or replace the playing track. Data sync is TopBar Refresh only.
    if (id === "library" && this.libraryLevel === "artists") void this.loadArtists();
    if (id === "favorites") void this.loadFavorites();
    if (id === "playlists") void this.loadPlaylists();
    if (id === "statistics" || id === "achievements") {
      void this.ensureCatalogTracks();
      if (!this.favorites.length) void this.loadFavorites();
      if (!this.playlists.length) void this.loadPlaylists();
      if (!this.allAlbums.length) void this.loadAllAlbums();
      if (!this.artists.length) void this.loadArtists();
    }
  }

  /**
   * Sidebar / bottom-nav entry point.
   * Same section again → reset internal navigation to that section's root.
   * Different section → normal navigate (preserves other sections' stacks).
   */
  activateNav(id: ViewId) {
    if (this.view === id) {
      void this.resetSectionRoot(id);
      return;
    }
    this.navigate(id);
  }

  /** Reset library to browse root (artists overview), like a fresh open. */
  async resetLibraryRoot() {
    this.view = "library";
    this.libraryLevel = "artists";
    this.libraryBrowse = "artists";
    this.selectedArtist = null;
    this.selectedAlbum = null;
    this.selectedGenre = null;
    this.moodFilterIds = [];
    this.moodMatchAll = false;
    this.query = "";
    this.albums = [];
    this.tracks = [];
    this.closeEdit();
    await this.loadArtists();
  }

  async resetSectionRoot(id: ViewId) {
    switch (id) {
      case "dashboard":
        // Soft remount of dashboard UI only — never touch player / refreshAll.
        this.dashboardHomeTick += 1;
        break;
      case "library":
        await this.resetLibraryRoot();
        break;
      case "studio":
        this.studioPane = "listen";
        this.studioHomeTick += 1;
        break;
      case "playlists":
        this.activePlaylistId = null;
        this.playlistTracks = [];
        void this.loadPlaylists();
        break;
      case "settings":
        this.settingsHomeTick += 1;
        break;
      default:
        // No internal stack — soft navigate (no player side effects).
        this.navigate(id);
        break;
    }
  }

  playTrack(track: Track, list: Track[], opts?: { preserveQueueOrder?: boolean }) {
    player.playTrack(track, list, opts);
  }

  /** Album / playlist: coda ordinata dal brano (o dall'inizio). */
  playSequence(list: Track[], startIndex = 0) {
    if (!list.length) return;
    player.playSequence(list, startIndex);
  }

  playAll(list: Track[]) {
    this.playSequence(list, 0);
  }

  playShuffled(list: Track[], start?: Track) {
    player.playShuffled(list, start);
  }

  playCollectionShuffle(seed: Track, pool: Track[]) {
    player.playCollectionShuffle(seed, pool, true);
  }

  playPoolShuffle(pool: Track[]) {
    player.playPoolShuffle(pool, true);
  }

  /** Smart radio da seed sulla libreria (o pool passato). */
  async playGlobalRadio(seed: Track, library?: Track[]) {
    const pool = library?.length ? library : await this.ensureCatalogTracks();
    if (!pool.length) {
      player.playSequence([seed], 0);
      return;
    }
    player.playRadioFromSeed(seed, pool, true);
  }

  playQueueIndex(index: number) {
    player.playQueueIndex(index);
  }

  async shuffleArtist() {
    if (!this.selectedArtist) return;
    const albums = this.albums.length
      ? this.albums
      : await api.artistAlbums(this.selectedArtist.id);
    const lists = await Promise.all(albums.map((a) => api.albumTracks(a.id)));
    const all = lists.flat();
    this.playPoolShuffle(all);
  }

  async shuffleLibrary() {
    const tracks = await this.ensureCatalogTracks();
    this.playPoolShuffle(tracks);
  }

  async radioFromCurrent() {
    const cur = this.current;
    if (!cur) return;
    const library = await this.ensureCatalogTracks();
    player.playRadioFromCurrent(library, true);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Pref keys that belong in user-state `settings` (must not ride along playCount flushes). */
const SETTINGS_PREF_KEYS = new Set([
  "theme",
  "customTheme",
  "glassSurfaces",
  "glassOpacity",
  "locale",
  "visualizerMode",
  "crossfadeSec",
]);

function prefsPatchTouchesSettings(patch: Partial<Record<string, unknown>>): boolean {
  for (const key of Object.keys(patch)) {
    if (SETTINGS_PREF_KEYS.has(key)) return true;
  }
  return false;
}

export const session = new ClientSession();
