import {
  applyAccountDeepLink,
  clearSelectedAccountId,
  getSelectedAccountId,
  rememberAvailableAccount,
  setSelectedAccountId,
} from "./account";
import {
  ApiError,
  api,
  isOfflineError,
  noteAlbumCovers,
  onAccountRejected,
  onHubReachability,
  type Album,
  type Artist,
  type LibraryStats,
  type MachineAccess,
  type Playlist,
  type ScanReport,
  type Track,
  type UserStatePatch,
  type UserStatePayload,
} from "./api";
import { getServerBaseUrl, setServerBaseUrl } from "./config";
import { connectGate } from "./connect.svelte";
import { hubModules } from "./hubModules.svelte";
import { isExternalTrack } from "./externalItems";
import { i18n, t } from "./i18n.svelte";
import { player, type QueueSnapshot, type QueueSyncChange } from "./player";
import { parseHubQueue } from "./queueSync";
import { buildSearchIndex, searchTracks, trackMatchesQuery, type SearchIndex } from "./search";
import { describeError, toasts } from "./toasts.svelte";
import { watchOtherTabs } from "./tabSync";
import {
  broadcastLibraryChange,
  watchLibraryChanges,
  type LibraryChange,
} from "./libraryEvents";
import { normalizeCustomTheme } from "./themeCatalog";
import {
  applyTheme,
  forgetTracksInPrefs,
  loadUserPrefs,
  migratePrefsToRelPaths,
  normalizeGlassOpacity,
  notifyUserPrefsReplaced,
  normalizeLocale,
  normalizeTheme,
  normalizeVisualizerMode,
  patchUserPrefs,
  setUserPrefsChangeListener,
  type CrossfadeSec,
  type UserPrefs,
} from "./userPrefs";
import {
  agreedBase,
  changedUserFields,
  conflictState,
  pushRetryDelay,
  rebaseUserState,
  sameJsonValue,
  syncedFieldsOf,
  type SyncedUserFields,
} from "./userStateMerge";

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
  | "settings"
  | "podcasts";
/** Settings tabs (stable ids, labels are translated). */
export type SettingsSection = "Account" | "Interfaccia" | "Libreria" | "Rete" | "Sistema";
/** A panel to scroll to once the settings tab is shown. */
export type SettingsTarget = { section: SettingsSection; anchor?: "integrations" };
export type LibraryLevel = "artists" | "artist" | "album" | "search";
export type LibraryBrowse = "artists" | "genres" | "moods" | "nebula";
/** Legacy `libOverviewSort`: artists / genres overview order. */
export type LibraryOverviewSort = "name" | "plays";
/** Legacy `artistAlbumSort`: album grid order on an artist page. */
export type ArtistAlbumSort = "date" | "name" | "plays";
const LIBRARY_BROWSE_IDS: readonly LibraryBrowse[] = ["artists", "genres", "moods", "nebula"];
export type StudioPane = "listen" | "catalog" | "download" | "meta" | "covers";
export type EditDialog = "none" | "track" | "album" | "cover";
export type RefreshOptions = { rescan?: boolean; notify?: boolean };
/** Combines this device's value of a synced key with the hub's (may be undefined). */
export type SyncedMerge = (local: unknown, remote: unknown) => unknown;

/** Resume events arrive in bursts (visibilitychange + pageshow + online). */
const RECOVERY_DEBOUNCE_MS = 450;
/** Below this, a foreground return reuses what the UI already has. */
const RECOVERY_MIN_GAP_MS = 15_000;
/** Debounce between a local prefs edit and the user-state push. */
const PUSH_DEBOUNCE_MS = 350;
/** Rebase-and-retry rounds after a 409 before backing off. */
const PUSH_CONFLICT_RETRIES = 2;
/** keepalive requests are capped (~64 KB) by browsers. */
const KEEPALIVE_MAX_BYTES = 60_000;
/** Hub outage: `/health` probe backoff (first try, ceiling). */
const OUTAGE_PROBE_MIN_MS = 1000;
const OUTAGE_PROBE_MAX_MS = 15_000;
/** While visible, re-read the account state this often (other devices' edits). */
const USER_STATE_POLL_MS = 60_000;
/** A focus / visibility return re-reads the account state if older than this. */
const USER_STATE_FOCUS_GAP_MS = 10_000;
/** Connect-screen probe answers younger than this replace the boot requests. */
const BOOT_PROBE_REUSE_MS = 15_000;
/** Scan progress poll while the hub indexes during bootstrap. */
const SCAN_POLL_MIN_MS = 800;
const SCAN_POLL_MAX_MS = 3000;

class ClientSession {
  view = $state<ViewId>("dashboard");
  /** Tab (and panel) Settings should open on; consumed by SettingsView. */
  settingsTarget = $state<SettingsTarget | null>(null);
  libraryLevel = $state<LibraryLevel>("artists");
  private browseState = $state<LibraryBrowse>("artists");
  private overviewSortState = $state<LibraryOverviewSort>("name");
  private artistAlbumSortState = $state<ArtistAlbumSort>("date");

  /**
   * Library browse mode. Remembered per account (hub `settings.libBrowse`,
   * like legacy): assigning it saves it.
   */
  get libraryBrowse(): LibraryBrowse {
    return this.browseState;
  }
  set libraryBrowse(next: LibraryBrowse) {
    if (!LIBRARY_BROWSE_IDS.includes(next)) return;
    this.browseState = next;
    if (this.syncedSettings.libBrowse !== next) this.setSyncedSetting("libBrowse", next);
  }

  /** Artists / genres overview order; per account (`settings.libOverviewSort`). */
  get libOverviewSort(): LibraryOverviewSort {
    return this.overviewSortState;
  }
  set libOverviewSort(next: LibraryOverviewSort) {
    if (next !== "name" && next !== "plays") return;
    this.overviewSortState = next;
    if (this.syncedSettings.libOverviewSort !== next) this.setSyncedSetting("libOverviewSort", next);
  }

  /** Album grid order on an artist page; per account (`settings.artistAlbumSort`). */
  get artistAlbumSort(): ArtistAlbumSort {
    return this.artistAlbumSortState;
  }
  set artistAlbumSort(next: ArtistAlbumSort) {
    if (next !== "date" && next !== "name" && next !== "plays") return;
    this.artistAlbumSortState = next;
    if (this.syncedSettings.artistAlbumSort !== next) this.setSyncedSetting("artistAlbumSort", next);
  }
  studioPane = $state<StudioPane>("listen");
  selectedGenre = $state<string | null>(null);
  moodFilterIds = $state<string[]>([]);
  moodMatchAll = $state(false);
  /**
   * Catalog cache for mood filters / dashboard mix.
   * Big lists are `$state.raw`: replace them (never mutate in place) — see
   * `patchTrack` for edits to a single track.
   */
  catalogTracks = $state.raw<Track[]>([]);
  /** Delta cursor for `library/changes`; null forces a full page-through. */
  catalogRevision: string | null = null;
  /** The bound account's catalog has been paged in at least once (it may be empty). */
  catalogLoaded = $state(false);
  moodPrefsTick = $state(0);

  artists = $state.raw<Artist[]>([]);
  albums = $state<Album[]>([]);
  allAlbums = $state.raw<Album[]>([]);
  tracks = $state<Track[]>([]);
  favorites = $state.raw<Track[]>([]);
  favoriteIds = $state.raw<Set<number>>(new Set());
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
  /**
   * Bumps on player state changes (track/queue/exclusions/counts) — drives
   * list/UI refresh. Play/pause and seeks no longer bump it.
   */
  tick = $state(0);
  /** Bumps on timeupdate / seek only — timeline/dock; must not refresh TrackList. */
  progressTick = $state(0);
  /** Bumps on play/pause only (`playing`), without re-deriving lists. */
  playStateTick = $state(0);
  /**
   * Hub user-state `settings` as last known (+ local edits not pushed yet).
   * Read through `syncedSetting`, write through `setSyncedSetting`.
   */
  private syncedSettings = $state.raw<Record<string, unknown>>(
    loadSyncedSettingsCache(accountKey()),
  );
  /** Remount Studio on sidebar re-click (clears local catalog drill-down). */
  studioHomeTick = $state(0);
  /** Remount Settings on sidebar re-click (restores default tab). */
  settingsHomeTick = $state(0);
  /** Remount Dashboard on sidebar re-click (fresh radio picks; player untouched). */
  dashboardHomeTick = $state(0);

  /**
   * Machine operations (scans, library path, integrations, backups, tunnel):
   * Default account on the hub machine (or remote admin). Optimistic: unknown
   * rights must not lock the UI on a slow hub — the hub still refuses.
   */
  readonly canManageMachine = $derived(
    this.machineAccess?.canManageMachine !== false,
  );
  /**
   * Library operations (Studio writes, file deletes, account create / rename /
   * delete): any account on the hub machine; remote clients need remote admin.
   */
  readonly canManageLibrary = $derived(
    this.machineAccess == null
      ? true
      : (this.machineAccess.canManageLibrary ??
          (this.machineAccess.local || this.machineAccess.allowRemoteAdmin)),
  );
  /** Why library operations are refused (`forbidden_remote`…), or null. */
  readonly libraryDeniedReason = $derived(this.machineAccess?.libraryDeniedReason ?? null);
  /** Why machine operations are refused (`forbidden_default_account`…), or null. */
  readonly machineDeniedReason = $derived(this.machineAccess?.machineDeniedReason ?? null);

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
    this.playStateTick;
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
  /** The push loop currently running (single flight). */
  private pushTask: Promise<void> | null = null;
  private pushAgain = false;
  /** Local edits since the last successful push (a hint: the diff decides). */
  private userStateDirty = false;
  /**
   * Settings keys (appearance, synced settings) edited here and not on the hub
   * yet. Only these ride along a push: play-count flushes from a fresh origin
   * must not send localStorage defaults (midnight) over the account theme. They
   * also win over the hub's values when a pull or a 409 rebase comes in.
   */
  private dirtySettingKeys = new Set<string>();
  /** Edit sequence per settings key: a key re-edited mid-push stays dirty. */
  private settingEditSeq = new Map<string, number>();
  private editSeq = 0;
  private pushFailures = 0;
  private pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fallback when localStorage refuses the sync base (quota / private mode). */
  private syncBaseMem: { account: string; base: SyncBase } | null = null;
  private suppressUserStatePush = false;
  private prefsListenerBound = false;
  /**
   * False until the first successful pull for the active account on this origin.
   * Blocks push of pristine localStorage defaults (new LAN/tunnel origin) over
   * server prefs that were set from localhost / another origin.
   */
  private hydrated = $state(false);
  /** Per-key merge for synced settings that must not be overwritten wholesale. */
  private syncedMerges = new Map<string, SyncedMerge>();

  /** Reactive: the active account's user state has been pulled at least once. */
  get userStateHydrated(): boolean {
    return this.hydrated;
  }
  /** Single-flight refresh; a stronger request waits for it, then runs. */
  private refreshTask: Promise<void> | null = null;
  private refreshQueued: RefreshOptions | null = null;
  private lastRefreshAt = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Single-flight full catalog page-through. */
  private catalogLoad: Promise<void> | null = null;
  /** Favourite toggles awaiting the hub, so a double tap cannot race itself. */
  private favoriteBusy = new Set<number>();

  /** Account ids the hub rejected: each triggers one rebind, never a loop. */
  private rejectedAccounts = new Set<string>();
  private accountRecovery: Promise<void> | null = null;

  /** The hub could not be reached; cleared by the first request that gets through. */
  private hubDown = $state(false);
  /** Running `/health` probe loop while the hub is unreachable. */
  private outageTimer: ReturnType<typeof setTimeout> | null = null;
  private outageDelay = OUTAGE_PROBE_MIN_MS;
  private outageRecovering = false;
  /** Last successful user-state pull (ms), for focus / poll throttling. */
  private lastPullAt = 0;
  /** Account switch in progress (single flight). */
  private switchTask: Promise<void> | null = null;
  /** Search index over the catalog, rebuilt when the catalog changes. */
  private searchIndexCache: { tracks: Track[]; index: SearchIndex<Track> } | null = null;
  /** In-flight list loads shared by concurrent callers (boot + views). */
  private loads = new Map<string, Promise<unknown>>();

  constructor() {
    onAccountRejected((id) => this.recoverFromRejectedAccount(id));
    onHubReachability((reachable) => {
      if (reachable) this.noteHubReachable();
      else this.markHubUnreachable();
    });
    player.setOutageListener(() => this.markHubUnreachable());
    player.setQueueSync((change) => this.onQueueChange(change));
    if (typeof window !== "undefined") {
      // The network came back (browser `online`, Android shell's network callback):
      // probe at once instead of waiting out the backoff. While a track waits for
      // the hub, the Android heartbeat also probes: with the screen off the page's
      // own timers are throttled, the backoff timer can be minutes late.
      const probeNow = () => {
        if (this.hubDown) this.retryHubNow();
      };
      window.addEventListener("online", probeNow);
      window.addEventListener("rekord:network", (event) => {
        if ((event as CustomEvent<{ available?: boolean }>).detail?.available) probeNow();
      });
      window.addEventListener("rekord:playback-watchdog", () => {
        if (player.waitingForHub) probeNow();
      });
    }
  }

  // ---- Hub reachability ------------------------------------------------------

  /** True while the hub cannot be reached (requests fail at the network level). */
  get hubOffline(): boolean {
    return this.hubDown || this.status === "offline";
  }

  /**
   * A request could not reach the hub: say so (top bar, banner) and probe
   * `/health` with backoff until it answers; then `onHubBack` resumes.
   */
  private markHubUnreachable() {
    this.hubDown = true;
    if (this.status !== "offline") this.status = "offline";
    if (!this.error) this.error = t("core.hub.unreachable");
    this.scheduleOutageProbe();
  }

  private scheduleOutageProbe() {
    if (this.outageTimer != null || typeof window === "undefined") return;
    const delay = this.outageDelay;
    this.outageDelay = Math.min(OUTAGE_PROBE_MAX_MS, Math.round(this.outageDelay * 2));
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      void this.probeOutage();
    }, delay);
  }

  private async probeOutage() {
    if (!this.hubDown) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.scheduleOutageProbe();
      return;
    }
    try {
      await api.health({ timeoutMs: 5000 });
      // `noteHubReachable` (via the reachability hook) takes it from here.
    } catch (e) {
      if (e instanceof ApiError && !e.offline) {
        this.noteHubReachable();
        return;
      }
      this.scheduleOutageProbe();
    }
  }

  /** "Retry now" (top bar, banner): probe the hub at once instead of waiting. */
  retryHubNow() {
    if (!this.hubDown) {
      void this.refreshAll();
      return;
    }
    if (this.outageTimer != null) clearTimeout(this.outageTimer);
    this.outageTimer = null;
    this.outageDelay = OUTAGE_PROBE_MIN_MS;
    void this.probeOutage();
  }

  /** Some request reached the hub: if we thought it was gone, recover. */
  private noteHubReachable() {
    if (!this.hubDown || this.outageRecovering) return;
    this.outageRecovering = true;
    queueMicrotask(() => void this.onHubBack());
  }

  private async onHubBack() {
    try {
      if (this.outageTimer != null) clearTimeout(this.outageTimer);
      this.outageTimer = null;
      this.outageDelay = OUTAGE_PROBE_MIN_MS;
      this.hubDown = false;
      this.status = this.stats?.scanning ? "indexing" : "online";
      this.error = "";
      // Playback first: the track that broke off reloads where it stopped.
      const resumed = player.resumeAfterOutage();
      toasts.ok(t(resumed ? "core.hub.backResumed" : "toast.backOnline"), { key: "hub-back" });
      await this.refreshAll();
    } finally {
      this.outageRecovering = false;
    }
  }

  // ---- Queue sync -------------------------------------------------------------

  /**
   * The player saved its queue: mirror it into the account's hub user-state
   * (`settings.queue`: the list, only when it changed; `settings.queueCursor`:
   * index + position, small). Restored on other devices and after a switch.
   */
  private onQueueChange(change: QueueSyncChange) {
    const snap = change.snapshot;
    if (change.list) {
      this.setSyncedSetting(
        "queue",
        snap.relPaths.length
          ? {
              relPaths: snap.relPaths,
              currentIndex: snap.index,
              relPath: snap.relPath,
              time: snap.time,
              updatedAt: snap.updatedAt,
            }
          : null,
      );
    }
    if (change.cursor || change.list) {
      this.setSyncedSetting(
        "queueCursor",
        snap.relPaths.length
          ? {
              currentIndex: snap.index,
              relPath: snap.relPath,
              time: snap.time,
              updatedAt: snap.updatedAt,
            }
          : null,
      );
    }
  }

  /** The account's queue as the hub knows it (list + newest cursor), or null. */
  private hubQueueSnapshot(): QueueSnapshot | null {
    return parseHubQueue(this.syncedSettings.queue, this.syncedSettings.queueCursor);
  }

  /**
   * Restore the bound account's listening session, paused: the newer of this
   * device's copy and the hub's. A legacy queue (`settings.legacyQueue`, from
   * a migrated 5.x account) is used once, only when the account has no queue
   * of its own, and is then cleared on the hub so it never comes back.
   */
  private restoreListeningSession() {
    if (player.sessionWasRestored) return;
    const hubQueue = this.hubQueueSnapshot();
    const legacy = this.pendingLegacyQueue;
    const legacyPaths = (legacy?.relPaths ?? []).filter(
      (p): p is string => typeof p === "string" && !!p,
    );
    if (legacy) {
      this.pendingLegacyQueue = null;
      // Consumed or superseded: either way it must not come back.
      if (this.userStateHydrated) this.setSyncedSetting("legacyQueue", null);
    }
    if (!hubQueue && !player.localQueueSnapshot() && legacyPaths.length) {
      player.hydrateQueueFromRelPaths(
        legacyPaths,
        typeof legacy?.currentIndex === "number" ? legacy.currentIndex : 0,
        this.catalogTracks,
      );
      return;
    }
    player.restorePersistedQueue(this.catalogTracks, hubQueue);
  }

  /**
   * The hub no longer knows the stored account (deleted from another device,
   * corrupted id): forget it, let the hub pick its default and reload. One
   * attempt per rejected id, so a hub that rejects everything cannot loop.
   */
  private recoverFromRejectedAccount(id: string) {
    if (this.accountRecovery || this.rejectedAccounts.has(id)) return;
    this.rejectedAccounts.add(id);
    const run = async () => {
      // Nothing of the dead account may be pushed anywhere, nor keep playing.
      this.hydrated = false;
      this.clearPendingUserStatePush();
      player.releaseAccount({ sync: false });
      clearSelectedAccountId();
      // No account bound until the hub picks one (pushes check this binding).
      this.activeAccountId = null;
      try {
        await api.ensureAccountSession();
      } catch {
        return;
      }
      const next = getSelectedAccountId();
      if (!next || next === id) return;
      this.bindAccountState(next);
      await this.refreshAll();
      this.restoreListeningSession();
      const account = await this.accountLabel(next);
      toasts.info(t("core.account.reset", { account }), { key: "account-reset" });
    };
    const task = run().finally(() => {
      if (this.accountRecovery === task) this.accountRecovery = null;
    });
    this.accountRecovery = task;
  }

  /** Guards the foreground probe from piling on top of a running refresh. */
  private get refreshing(): boolean {
    return this.refreshTask != null;
  }

  private hasPendingPush(): boolean {
    return this.userStateDirty || this.dirtySettingKeys.size > 0 || this.pushTimer != null;
  }

  private clearPendingUserStatePush() {
    this.userStateDirty = false;
    this.dirtySettingKeys.clear();
    this.settingEditSeq.clear();
    this.pushAgain = false;
    this.pushFailures = 0;
    if (this.pushTimer != null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.pushRetryTimer != null) {
      clearTimeout(this.pushRetryTimer);
      this.pushRetryTimer = null;
    }
  }

  private ensurePrefsSync() {
    if (this.prefsListenerBound) return;
    this.prefsListenerBound = true;
    setUserPrefsChangeListener((prefs, patch) => {
      if (this.suppressUserStatePush) return;
      this.markEdited(Object.keys(patch), prefs);
      this.pushUserStateDebounced();
    });
  }

  /** Record a local edit; settings keys are tracked one by one. */
  private markEdited(keys: string[], prefs?: UserPrefs) {
    this.editSeq += 1;
    this.userStateDirty = true;
    const settingKeys = keys.filter((k) => SETTINGS_PREF_KEYS.has(k));
    if (!settingKeys.length) return;
    const values = settingsFromPrefs(prefs ?? loadUserPrefs());
    const next = { ...this.syncedSettings };
    for (const key of settingKeys) {
      this.dirtySettingKeys.add(key);
      this.settingEditSeq.set(key, this.editSeq);
      next[key] = values[key];
    }
    this.syncedSettings = next;
  }

  /**
   * Per-account setting stored in the hub user-state `settings[key]`, synced
   * across devices. Reactive. `undefined` until known (pull / local cache).
   */
  syncedSetting<T = unknown>(key: string): T | undefined {
    return this.syncedSettings[key] as T | undefined;
  }

  /**
   * Write a synced setting: applied locally at once, pushed to the hub with
   * the next (debounced) user-state push. A key edited here wins over the
   * hub's value on conflicts until it has been pushed.
   */
  setSyncedSetting(key: string, value: unknown): void {
    const k = key.trim();
    if (!k) return;
    if (SETTINGS_PREF_KEYS.has(k)) {
      // Appearance keys live in prefs; the prefs listener does the rest.
      patchUserPrefs({ [k]: value } as Partial<UserPrefs>);
      return;
    }
    this.syncedSettings = { ...this.syncedSettings, [k]: value };
    saveSyncedSettingsCache(accountKey(), this.syncedSettings);
    this.editSeq += 1;
    this.dirtySettingKeys.add(k);
    this.settingEditSeq.set(k, this.editSeq);
    this.pushUserStateDebounced();
  }

  /**
   * Merge for a synced key whose local and hub values must be combined
   * rather than one replacing the other (records collected on several
   * devices). Applied at every pull and 409 rebase, whether or not the key
   * was edited here; a result that differs from the hub's value is pushed.
   * Returns an unregister function.
   */
  registerSyncedMerge(key: string, merge: SyncedMerge): () => void {
    this.syncedMerges.set(key, merge);
    return () => {
      if (this.syncedMerges.get(key) === merge) this.syncedMerges.delete(key);
    };
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
    // Leaving / backgrounding: push now, with keepalive so the request
    // survives the page going away (mobile kills hidden tabs without notice).
    const flush = () => {
      void this.flushUserStatePush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    const unsub = player.subscribe(() => {
      this.tick += 1;
      this.crossfadeSec = player.crossfadeSec;
    });
    const unsubProgress = player.subscribeProgress(() => {
      this.progressTick += 1;
    });
    const unsubPlayState = player.subscribePlayState(() => {
      this.playStateTick += 1;
    });
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      unsub();
      unsubProgress();
      unsubPlayState();
    };
  }

  /** Legacy parity: missing cover only on non-loose albums. */
  readonly albumsWithoutCover = $derived(
    this.stats?.albums_without_cover ??
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
    if (this.userStateHydrated && !opts?.skipFlush && this.hasPendingPush()) {
      await this.flushUserStatePush();
    } else if (!this.userStateHydrated || opts?.skipFlush) {
      this.clearPendingUserStatePush();
    }
    const account = accountKey();
    let remote: UserStatePayload;
    try {
      remote = await api.getUserState();
    } catch {
      /* server may be older / offline — keep unhydrated so we never push defaults */
      return;
    }
    // The account changed while the request was out: that state is not ours.
    if (account !== accountKey()) return;
    // Edits a failed flush (or a closed page) left behind are rebased on top
    // of the hub's state, not thrown away. Needs a stored base for this
    // account: a brand-new origin has none and takes the hub's state.
    const pending = this.applyRemoteUserState(remote, {
      rebase: !opts?.skipFlush,
      legacyQueue: true,
    });
    if (pending) this.pushUserStateDebounced();
  }

  /**
   * Bring the hub's user state into prefs + DOM.
   * - `rebase`: replay local edits not pushed yet on top (three-way merge
   *   against the last agreed state) and keep dirty settings keys.
   * - `legacyQueue`: pick up a backup's queue for the one-shot cold restore.
   * Returns true when local edits remain to be pushed.
   */
  private applyRemoteUserState(
    remote: Partial<UserStatePayload> & { revision?: number },
    opts: { rebase: boolean; legacyQueue?: boolean },
  ): boolean {
    const account = accountKey();
    const keep = opts.rebase ? new Set(this.dirtySettingKeys) : new Set<string>();
    let pending = false;
    this.suppressUserStatePush = true;
    try {
      const local = loadUserPrefs();
      const localFields = fieldsFromPrefs(local);
      const remoteFields = syncedFieldsOf(remote);
      const stored = this.readSyncBase(account);
      let fields: SyncedUserFields;
      if (opts.rebase && stored) {
        // A push whose answer was lost may have landed: see `agreedBase`.
        const base = agreedBase(stored.fields, stored.inflight, remoteFields);
        // Nothing new here: the hub's copy is the truth, including removals
        // (a union would resurrect counts another device cleared).
        fields =
          changedUserFields(base, localFields).length > 0
            ? rebaseUserState(base, localFields, remoteFields)
            : remoteFields;
      } else {
        // No agreed base for this account on this device (first pull here,
        // or a hub restore): the hub's copy is the account's truth. Local
        // values may come from anywhere (an old build copied the default
        // account's prefs into new accounts) and must never be unioned in
        // and pushed back.
        fields = {
          playCounts: { ...remoteFields.playCounts },
          recentRelPaths: [...remoteFields.recentRelPaths],
          trackMoods: { ...remoteFields.trackMoods },
          excludedRelPaths: [...remoteFields.excludedRelPaths],
          excludedAlbumIds: [...remoteFields.excludedAlbumIds],
        };
      }
      pending = changedUserFields(remoteFields, fields).length > 0;

      const settings = (remote.settings ?? {}) as Record<string, unknown>;
      const patch: Partial<UserPrefs> = { ...fields };
      // Appearance: hub wins except for keys edited here and not pushed yet.
      // Never invent midnight when the server omits theme.
      Object.assign(patch, prefsPatchFromSettings(settings, keep));
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
      if (opts.legacyQueue) {
        const lq = settings.legacyQueue as
          | { relPaths?: string[]; currentIndex?: number }
          | null
          | undefined;
        this.pendingLegacyQueue = lq && Array.isArray(lq.relPaths) && lq.relPaths.length ? lq : null;
      }
      const firstPull = !this.hydrated;
      const nextSettings: Record<string, unknown> = { ...settings };
      for (const key of keep) nextSettings[key] = this.syncedSettings[key];
      const mergedDirty = new Set<string>();
      for (const [key, merge] of this.syncedMerges) {
        const mine = this.syncedSettings[key];
        if (mine === undefined) continue;
        let merged: unknown;
        try {
          merged = merge(mine, settings[key]);
        } catch {
          continue;
        }
        nextSettings[key] = merged;
        // Key order differs once the value went through the hub (sorted map).
        if (!sameJsonValue(merged, settings[key])) {
          this.editSeq += 1;
          this.dirtySettingKeys.add(key);
          this.settingEditSeq.set(key, this.editSeq);
          mergedDirty.add(key);
        }
      }
      this.syncedSettings = nextSettings;
      saveSyncedSettingsCache(account, nextSettings);
      // Browse mode / sort orders: taken from the hub when the account is
      // (re)bound, not on later pulls — a device must not flip the library
      // under someone who is browsing it.
      if (firstPull) this.applyLibraryPrefs(nextSettings);
      this.writeSyncBase(account, {
        revision: typeof remote.revision === "number" ? remote.revision : null,
        fields: remoteFields,
      });
      this.moodPrefsTick += 1;
      this.hydrated = true;
      this.lastPullAt = Date.now();
      if (!opts.rebase) {
        // Hub wins; merged keys stay dirty only if the merge added something.
        for (const key of [...this.dirtySettingKeys]) {
          if (mergedDirty.has(key)) continue;
          this.dirtySettingKeys.delete(key);
          this.settingEditSeq.delete(key);
        }
      }
    } finally {
      this.suppressUserStatePush = false;
    }
    if (pending || this.dirtySettingKeys.size > 0) {
      this.userStateDirty = this.userStateDirty || pending;
      return true;
    }
    return false;
  }

  private readSyncBase(account: string): SyncBase | null {
    const stored = loadSyncBase(account);
    if (stored) return stored;
    const mem = this.syncBaseMem;
    return mem && mem.account === account ? mem.base : null;
  }

  private writeSyncBase(account: string, base: SyncBase) {
    this.syncBaseMem = { account, base };
    saveSyncBase(account, base);
  }

  private pendingLegacyQueue: {
    relPaths?: string[];
    currentIndex?: number;
  } | null = null;

  /** Browse mode and sort orders saved for the account (hub settings). */
  private applyLibraryPrefs(settings: Record<string, unknown>) {
    const browse = settings.libBrowse;
    // Nebula is the heaviest view there is: never the landing state.
    if (typeof browse === "string" && LIBRARY_BROWSE_IDS.includes(browse as LibraryBrowse)) {
      this.browseState = browse === "nebula" ? "artists" : (browse as LibraryBrowse);
    }
    const overview = settings.libOverviewSort;
    if (overview === "name" || overview === "plays") this.overviewSortState = overview;
    const albums = settings.artistAlbumSort;
    if (albums === "date" || albums === "name" || albums === "plays") {
      this.artistAlbumSortState = albums;
    }
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
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * Push local user-state edits now. Single flight: a call during a push
   * waits for it and makes it go round once more. Failures keep everything
   * dirty and retry with backoff; never rejects.
   */
  async flushUserStatePush(opts?: { keepalive?: boolean }): Promise<void> {
    if (this.pushTimer != null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.suppressUserStatePush) return;
    if (!this.userStateHydrated) return;
    if (this.pushTask) {
      this.pushAgain = true;
      // Page going away: nothing to wait for, the running push carries on.
      if (!opts?.keepalive) await this.pushTask;
      return;
    }
    if (!this.hasPendingPush() && !this.pushAgain) return;
    const task = this.runPushLoop();
    this.pushTask = task;
    try {
      await task;
    } finally {
      if (this.pushTask === task) this.pushTask = null;
    }
  }

  private async runPushLoop() {
    do {
      this.pushAgain = false;
      try {
        await this.pushOnce();
        this.pushFailures = 0;
        if (this.pushRetryTimer != null) {
          clearTimeout(this.pushRetryTimer);
          this.pushRetryTimer = null;
        }
      } catch (e) {
        // Keep the dirty state: the next edit, the retry or a pull sends it.
        this.pushFailures += 1;
        // A hub that refuses the body will refuse it again: wait for an edit.
        if (!isPermanentRejection(e)) this.schedulePushRetry();
        return;
      }
    } while (this.pushAgain && (this.userStateDirty || this.dirtySettingKeys.size > 0));
  }

  private schedulePushRetry() {
    if (this.pushRetryTimer != null) return;
    const delay = pushRetryDelay(this.pushFailures - 1);
    this.pushRetryTimer = setTimeout(() => {
      this.pushRetryTimer = null;
      void this.flushUserStatePush();
    }, delay);
  }

  /**
   * One PATCH with only what changed since the last agreed state, guarded by
   * its revision. On 409: take the hub's state, replay local edits on top
   * (play counts add up, dirty settings keys win) and try again.
   */
  private async pushOnce() {
    const account = accountKey();
    // Another tab rebound the client and this one has not followed yet: the
    // dirty state here belongs to the old account (`followAccountFromTab`
    // drops it), the stored binding to the new one.
    const bound = (this.activeAccountId ?? "").trim();
    if (bound && bound !== account) return;
    for (let round = 0; ; round++) {
      const seq = this.editSeq;
      const prefs = loadUserPrefs();
      const local = fieldsFromPrefs(prefs);
      const stored = this.readSyncBase(account);
      const fields = changedUserFields(stored?.fields ?? null, local);
      const settingKeys = [...this.dirtySettingKeys];
      if (!fields.length && !settingKeys.length) {
        if (seq === this.editSeq) this.userStateDirty = false;
        return;
      }
      const body: UserStatePatch = {};
      const target = body as Record<string, unknown>;
      for (const field of fields) target[field] = local[field];
      if (settingKeys.length) body.settings = this.settingsPayload(prefs, settingKeys);
      if (stored?.revision != null) body.expectedRevision = stored.revision;
      const settingSeqs = settingKeys.map(
        (k) => [k, this.settingEditSeq.get(k) ?? 0] as const,
      );
      // Every push that fits goes out with keepalive, not only the page-hide
      // flush: a reload, a closed tab or an account switch while this PATCH is
      // on the wire must not cancel it (it used to end as ERR_ABORTED).
      const useKeepalive = JSON.stringify(body).length <= KEEPALIVE_MAX_BYTES;
      // What the hub holds if this lands. Journaled first: the answer may never
      // arrive (timeout, page closing) even though the write went through.
      const sent: SyncedUserFields = { ...(stored?.fields ?? local) };
      for (const field of fields) {
        (sent as Record<string, unknown>)[field] = local[field];
      }
      if (stored && fields.length) this.writeSyncBase(account, { ...stored, inflight: sent });
      try {
        const res = await api.patchUserState(
          body,
          useKeepalive ? { keepalive: true } : undefined,
        );
        this.writeSyncBase(account, {
          revision: typeof res?.revision === "number" ? res.revision : null,
          fields: sent,
        });
        for (const [key, keySeq] of settingSeqs) {
          if ((this.settingEditSeq.get(key) ?? 0) === keySeq) {
            this.dirtySettingKeys.delete(key);
            this.settingEditSeq.delete(key);
          }
        }
        if (seq === this.editSeq) this.userStateDirty = false;
        return;
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          round < PUSH_CONFLICT_RETRIES &&
          account === accountKey()
        ) {
          const current =
            (conflictState(e.body) as Partial<UserStatePayload> | null) ??
            (await api.getUserState());
          if (account !== accountKey()) return;
          this.applyRemoteUserState(current, { rebase: true });
          continue;
        }
        throw e;
      }
    }
  }

  private settingsPayload(prefs: UserPrefs, keys: string[]): Record<string, unknown> {
    const fromPrefs = settingsFromPrefs(prefs);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const value = SETTINGS_PREF_KEYS.has(key) ? fromPrefs[key] : this.syncedSettings[key];
      // `undefined` would vanish from the JSON: null clears the key on the hub.
      out[key] = value === undefined ? null : value;
    }
    return out;
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
      const conflict = e instanceof ApiError && e.status === 409;
      if (!conflict && !/already in progress|Conflict/i.test(msg)) throw e;
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
   *
   * Single flight: never two at once. Calls made while one runs are folded
   * into a single follow-up run (their data must be at least as new as the
   * call), with the strongest options any of them asked for.
   */
  refreshAll(opts?: RefreshOptions & { skipHealth?: boolean }): Promise<void> {
    if (this.refreshTask) {
      this.refreshQueued = {
        rescan: Boolean(this.refreshQueued?.rescan || opts?.rescan),
        notify: Boolean(this.refreshQueued?.notify || opts?.notify),
      };
      return this.refreshTask.then(() => {
        const queued = this.refreshQueued;
        this.refreshQueued = null;
        // Another waiter already started the follow-up: share it.
        if (!queued) return this.refreshTask ?? undefined;
        return this.refreshAll(queued);
      });
    }
    const task = this.runRefresh(opts).finally(() => {
      if (this.refreshTask === task) this.refreshTask = null;
    });
    this.refreshTask = task;
    return task;
  }

  private async runRefresh(opts?: RefreshOptions & { skipHealth?: boolean }) {
    // While the hub is known to be down the top bar keeps saying so.
    if (!this.hubDown) {
      this.status = "…";
      this.error = "";
    }
    // One toast per sync, reused by the retry loops so they cannot pile up.
    const job = opts?.notify ? toasts.busy(t("toast.syncBusy"), "library-sync") : null;
    const goOffline = (e: unknown) => {
      // With a toast up, the banner would say the same thing twice.
      if (job) job.done(t("toast.syncFailed", { error: describeError(e) }), "error");
      else this.error = describeError(e);
      this.markHubUnreachable();
    };
    let scanned = false;
    let report: ScanReport | null = null;
    try {
      if (!opts?.skipHealth) {
        try {
          hubModules.apply(await api.health());
        } catch (e) {
          // A hub that answers, even with an error, is not "offline".
          if (isOfflineError(e) || !(e instanceof ApiError)) {
            goOffline(e);
            return;
          }
        }
      }
      // Scanning is a machine operation: remote clients just re-read the hub.
      if (opts?.rescan && this.canManageMachine) {
        this.status = "indexing";
        job?.update(t("toast.syncScanning"));
        try {
          report = await this.rescanLibrary();
          scanned = true;
        } catch (e) {
          if (isOfflineError(e)) {
            goOffline(e);
            return;
          }
          toasts.error(t("core.refresh.scanFailed", { error: describeError(e) }));
        }
      }
      // Each endpoint on its own: one failing list must not blank the others
      // or flip the whole client "offline".
      const loaders: [string, () => Promise<unknown>][] = [
        ["stats", () => this.loadStats()],
        ["machineAccess", () => this.loadMachineAccess()],
        ["artists", () => this.loadArtists()],
        ["albums", () => this.loadAllAlbums()],
        ["favorites", () => this.loadFavorites()],
        ["playlists", () => this.loadPlaylists()],
        // Delta sync on refresh; only the first load pages the whole catalog.
        ["catalog", () => this.syncCatalogDelta()],
        ["userState", () => this.pullUserState()],
      ];
      const results = await Promise.allSettled(loaders.map(([, run]) => run()));
      const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (failures.length === results.length && failures.some(isOfflineError)) {
        goOffline(failures.find(isOfflineError));
        return;
      }
      // Remap prefs that used SQLite ids before the last catalog wipe/rescan.
      if (this.catalogTracks.length) {
        migratePrefsToRelPaths(this.catalogTracks);
        player.reloadExclusionsFromPrefs();
      }
      this.status = this.stats?.scanning ? "indexing" : "online";
      if (failures.length) {
        const message = t("core.refresh.partial", {
          count: failures.length,
          error: describeError(failures[0]),
        });
        if (job) job.done(message, "error");
        else toasts.error(message, { key: "refresh-partial" });
      } else {
        job?.done(this.syncSummary(report, scanned));
      }
    } catch (e) {
      goOffline(e);
    } finally {
      this.lastRefreshAt = Date.now();
    }
  }

  /**
   * Switch account without a page reload, like legacy but in the right order:
   * 1. save the outgoing account's queue + position (locally and in its hub
   *    user-state) and flush its pending edits, while it is still bound;
   * 2. stop playback — nothing more is credited to anyone;
   * 3. bind the new account, reset caches and views;
   * 4. pull its state and restore its own queue, paused.
   * Prefs are never copied between accounts.
   */
  switchAccount(accountId: string): Promise<void> {
    const id = (accountId || "").trim();
    if (!id) return Promise.resolve();
    if (this.switchTask) {
      return this.switchTask.then(() => this.switchAccount(id));
    }
    if (id === getSelectedAccountId()) return Promise.resolve();
    const task = this.runSwitchAccount(id).finally(() => {
      if (this.switchTask === task) this.switchTask = null;
    });
    this.switchTask = task;
    return task;
  }

  private async runSwitchAccount(accountId: string) {
    // 1 + 2: the player saves the old queue (its sync lands in this account's
    // synced settings) and stops; then the old account's edits go out.
    player.releaseAccount();
    await this.releaseAccount();
    // 3
    setSelectedAccountId(accountId);
    this.bindAccountState(accountId);
    // 4
    await this.refreshAll();
    this.restoreListeningSession();
  }

  /** Persist the outgoing account before the binding changes. */
  private async releaseAccount() {
    // Settings-only edits (synced settings, a failed push waiting for its
    // retry) and a push already on the wire count too.
    if (this.userStateHydrated && (this.hasPendingPush() || this.pushTask != null)) {
      await this.flushUserStatePush();
    }
    // Next account must pull before any push (empty local key ≠ server defaults).
    this.hydrated = false;
    this.clearPendingUserStatePush();
  }

  /**
   * Everything of the previous account goes: lists, catalog (the library
   * selection is per account), drill-downs, filters, search, synced
   * settings; then the new account's local prefs and theme are painted.
   */
  private bindAccountState(accountId: string) {
    player.bindAccount(accountId);
    this.pendingLegacyQueue = null;
    this.catalogTracks = [];
    this.catalogRevision = null;
    this.catalogLoaded = false;
    this.searchIndexCache = null;
    this.artists = [];
    this.albums = [];
    this.allAlbums = [];
    this.tracks = [];
    this.favorites = [];
    this.favoriteIds = new Set();
    this.playlists = [];
    // Rights depend on the account (machine ops need Default).
    this.machineAccess = null;
    this.selectedGenre = null;
    this.moodFilterIds = [];
    this.moodMatchAll = false;
    this.query = "";
    this.closeEdit();
    this.browseState = "artists";
    this.overviewSortState = "name";
    this.artistAlbumSortState = "date";
    this.applyAccountLocally(accountId);
    // Remount the views that keep their own copies (dashboard picks, studio).
    this.dashboardHomeTick += 1;
    this.studioHomeTick += 1;
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
      this.syncedSettings = loadSyncedSettingsCache(accountId);
      this.applyLibraryPrefs(this.syncedSettings);
      this.activePlaylistId = null;
      this.playlistTracks = [];
      this.selectedArtist = null;
      this.selectedAlbum = null;
      this.libraryLevel = "artists";
      this.moodPrefsTick += 1;
      i18n.applySaved();
      // Lists keyed on play counts / moods re-derive for this account.
      notifyUserPrefsReplaced(accountId);
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
    // The binding already points at the new account, so a push now would mix
    // its prefs with this account's dirty settings and send the lot to it.
    // Unpushed plays stay in the old account's prefs and sync base and are
    // rebased on its next pull. The old queue is saved locally (player keys
    // are per account) and playback stops: this tab now speaks for another.
    this.hydrated = false;
    this.clearPendingUserStatePush();
    player.releaseAccount({ sync: false });
    this.bindAccountState(accountId);
    await this.refreshAll();
    this.restoreListeningSession();
    const account = await this.accountLabel(accountId);
    toasts.info(t("toast.accountFromTab", { account }));
  }

  /** Re-read prefs a sibling tab just rewrote for the account we are on. */
  private followPrefsFromTab(accountId: string) {
    if (accountId !== (this.activeAccountId || "default")) return;
    this.hydrateThemeFromLocal();
    // Lists keyed on counts / moods / recents re-derive from the new blob.
    notifyUserPrefsReplaced(accountId);
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
    const stopLibrary = watchLibraryChanges((change) =>
      this.applyLibraryChange(change, { broadcast: false }),
    );
    const stopConnection = this.watchConnection();
    return () => {
      stopTabs();
      stopLibrary();
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
    const onOffline = () => this.markHubUnreachable();
    const onOnline = () => {
      // Probe at once instead of waiting for the backoff.
      if (this.hubDown) {
        if (this.outageTimer != null) clearTimeout(this.outageTimer);
        this.outageTimer = null;
        this.outageDelay = OUTAGE_PROBE_MIN_MS;
        void this.probeOutage();
      }
      schedule();
    };
    const onFocus = () => this.pullIfStale(USER_STATE_FOCUS_GAP_MS);
    // Other devices edit the same account: re-read it now and then while
    // someone is looking (never in the background).
    const poll = setInterval(() => this.pullIfStale(USER_STATE_POLL_MS - 1000), USER_STATE_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    return () => {
      if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      if (this.outageTimer != null) clearTimeout(this.outageTimer);
      this.outageTimer = null;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onFocus);
    };
  }

  /** Quiet user-state pull when the last one is older than `gapMs`. */
  private pullIfStale(gapMs: number) {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (this.hubDown || this.refreshing || this.switchTask) return;
    if (!this.userStateHydrated) return;
    if (Date.now() - this.lastPullAt < gapMs) return;
    this.lastPullAt = Date.now();
    void this.pullUserState();
  }

  private async recoverNow() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.refreshing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.markHubUnreachable();
      return;
    }
    // A hub outage recovers through its own probe (`onHubBack`).
    if (this.hubDown) return;
    const wasDown = Boolean(this.error);
    // A quick tab switch should not re-pull everything.
    if (!wasDown && Date.now() - this.lastRefreshAt < RECOVERY_MIN_GAP_MS) {
      this.pullIfStale(USER_STATE_FOCUS_GAP_MS);
      return;
    }
    await this.refreshAll();
    if (wasDown && this.status !== "offline") toasts.ok(t("toast.backOnline"), { key: "hub-back" });
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
    // The connect gate just asked the hub "health + accounts": reuse that
    // answer instead of asking the same two questions again.
    const probe = connectGate.takeRecentProbe(BOOT_PROBE_REUSE_MS);
    if (probe) {
      rememberAvailableAccount(probe);
    } else {
      try {
        await api.ensureAccountSession();
      } catch {
        /* offline / first paint — retry via refreshAll */
      }
    }
    // Account id may have been bound just now — re-paint from that key before pull.
    this.activeAccountId = getSelectedAccountId();
    player.bindAccount(this.activeAccountId);
    this.hydrateThemeFromLocal();
    notifyUserPrefsReplaced(this.activeAccountId);
    const started = Date.now();
    let delay = 400;
    let first = true;
    while (Date.now() - started < maxWaitMs) {
      await this.refreshAll(first && probe ? { skipHealth: true } : undefined);
      first = false;
      if (this.status === "offline") {
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), 3000);
        continue;
      }
      if (this.stats?.scanning) {
        // Poll only the scan status; one full refresh once it is done.
        this.error = "";
        await this.waitForScanIdle(maxWaitMs - (Date.now() - started));
        delay = 400;
        continue;
      }
      // Online and idle: done (even if library is intentionally empty).
      this.tryRestoreListeningSession();
      return;
    }
    this.tryRestoreListeningSession();
  }

  /**
   * Cheap wait for a running scan: only `library/stats`, no list reloads.
   * Returns when the hub is idle, unreachable or the budget is spent.
   */
  private async waitForScanIdle(budgetMs: number) {
    const until = Date.now() + Math.max(0, budgetMs);
    let wait = SCAN_POLL_MIN_MS;
    while (Date.now() < until) {
      this.status = "indexing";
      await sleep(wait);
      try {
        this.stats = await api.stats();
      } catch {
        return;
      }
      if (!this.stats.scanning) return;
      wait = Math.min(Math.round(wait * 1.25), SCAN_POLL_MAX_MS);
    }
  }

  /**
   * Restore the account's queue + index + position, paused (never gated by
   * settings). Kept under its old name for callers.
   */
  tryRestoreListeningSession() {
    this.restoreListeningSession();
  }

  /**
   * One request per list and account at a time: boot, views mounting and
   * refreshes ask for the same lists at once. Keyed by the account the
   * request is sent for (the stored binding, which is what the headers
   * carry), so a load started before boot finished binding is shared with
   * the boot's own load of the same account. If the binding changes while a
   * load is out, its result is dropped and the list is loaded again for the
   * account now bound: callers never get a stale or empty list.
   */
  private shared<T>(key: string, run: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    const account = accountKey();
    const slot = `${key}@${account}`;
    const existing = this.loads.get(slot) as Promise<void> | undefined;
    if (existing) return existing;
    const task = (async () => {
      const value = await run();
      if (account === accountKey()) {
        apply(value);
        return;
      }
      // Rebound mid-flight: this answer belongs to the old account.
      await this.shared(key, run, apply);
    })().finally(() => {
      if (this.loads.get(slot) === task) this.loads.delete(slot);
    });
    this.loads.set(slot, task);
    return task;
  }

  async loadStats() {
    await this.shared("stats", () => api.stats(), (v) => (this.stats = v));
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
    await this.shared("artists", () => api.artists(), (v) => (this.artists = v));
  }

  async loadAllAlbums() {
    await this.shared(
      "albums",
      () => api.albums(),
      (v) => {
        // Covers / names changed elsewhere (Studio, another client): the
        // player queue and the open album follow the fresh list.
        const prev = new Map(this.allAlbums.map((a) => [a.id, a]));
        const changed = v.filter((a) => {
          const old = prev.get(a.id);
          return (
            old != null &&
            ((old.cover_version ?? null) !== (a.cover_version ?? null) ||
              old.has_cover !== a.has_cover ||
              old.name !== a.name)
          );
        });
        // Track covers of albums known to have none are not requested.
        noteAlbumCovers(v);
        this.allAlbums = v;
        if (changed.length) {
          this.applyLibraryChange(
            {
              albums: changed.map((a) => ({
                id: a.id,
                name: a.name,
                has_cover: a.has_cover,
                cover_version: a.cover_version ?? null,
              })),
            },
            { broadcast: false },
          );
        }
      },
    );
  }

  /**
   * Page through the personal library instead of one capped request, so large
   * libraries are complete (the old 2000 cap silently truncated them) and the
   * first page paints while the rest streams in.
   */
  loadCatalogTracks(): Promise<void> {
    if (this.catalogLoad) return this.catalogLoad;
    const task = this.pageCatalogTracks().finally(() => {
      if (this.catalogLoad === task) this.catalogLoad = null;
    });
    this.catalogLoad = task;
    return task;
  }

  private async pageCatalogTracks() {
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
    this.catalogLoaded = true;
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
    if (this.catalogLoad) {
      await this.catalogLoad;
      return true;
    }
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
    // Edited tracks (here, in Studio or on another client) also reach the
    // lists on screen and the player queue / bar / OS media controls.
    if (changes.updated.length) {
      this.applyLibraryChange({ tracks: changes.updated }, { broadcast: false });
    }
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

  /** Catalog for radio / mixes / stats; never rejects (toast + what we have). */
  async ensureCatalogTracks(): Promise<Track[]> {
    if (this.catalogTracks.length && !this.catalogLoad) return this.catalogTracks;
    try {
      await this.loadCatalogTracks();
    } catch (e) {
      if (!this.catalogTracks.length) toasts.fail(e, { key: "catalog-load" });
    }
    return this.catalogTracks;
  }

  /**
   * Replace one track (by rel_path) in every list that holds it. Lists are
   * immutable (`$state.raw`): editing a Track object in place does not
   * re-render anything — call this after a metadata save instead.
   */
  patchTrack(relPath: string, patch: Partial<Track>) {
    this.applyLibraryChange({ tracks: [{ ...patch, rel_path: relPath }] });
  }

  /**
   * One entry point for every library edit — made here (track / album edit,
   * cover save, Studio apply) or reported by the hub (catalog delta, album
   * list) or by another tab. Patches the lists on screen, the album
   * selection, the player queue (bar, Listen view, queue, OS media controls)
   * and the cover cache-busting versions in one go, then tells other tabs.
   * Album-level fields (`name`, `cover_version`, `has_cover`) reach every
   * track of that album.
   */
  applyLibraryChange(change: LibraryChange, opts: { broadcast?: boolean } = {}) {
    const byPath = new Map<string, Partial<Track>>();
    for (const item of change.tracks ?? []) {
      if (!item?.rel_path) continue;
      const { rel_path, ...rest } = item;
      byPath.set(rel_path, { ...byPath.get(rel_path), ...rest });
    }
    const byAlbum = new Map<number, Partial<Album>>();
    for (const item of change.albums ?? []) {
      if (typeof item?.id !== "number") continue;
      const { id, ...rest } = item;
      byAlbum.set(id, { ...byAlbum.get(id), ...rest });
    }
    if (!byPath.size && !byAlbum.size) return;

    const fromAlbum = new Map<number, Partial<Track>>();
    for (const [id, a] of byAlbum) {
      const p: Partial<Track> = {};
      if (a.name != null) p.album_name = a.name;
      if ("cover_version" in a) p.cover_version = a.cover_version ?? null;
      if (a.has_cover != null) p.has_cover = a.has_cover;
      if (Object.keys(p).length) fromAlbum.set(id, p);
    }
    const patchFor = (tr: Track): Partial<Track> | null => {
      const a = tr.album_id != null ? fromAlbum.get(tr.album_id) : undefined;
      const own = byPath.get(tr.rel_path);
      if (!a && !own) return null;
      return { ...a, ...own };
    };
    const apply = (list: Track[]) => {
      let changed = false;
      const next = list.map((tr) => {
        const p = patchFor(tr);
        if (!p) return tr;
        changed = true;
        return { ...tr, ...p };
      });
      return changed ? next : list;
    };
    this.catalogTracks = apply(this.catalogTracks);
    this.favorites = apply(this.favorites);
    this.tracks = apply(this.tracks);
    this.playlistTracks = apply(this.playlistTracks);

    if (byAlbum.size) {
      this.allAlbums = this.allAlbums.map((a) =>
        byAlbum.has(a.id) ? { ...a, ...byAlbum.get(a.id) } : a,
      );
      noteAlbumCovers(this.allAlbums.filter((a) => byAlbum.has(a.id)));
      const sel = this.selectedAlbum;
      // In place: the album page keeps its identity (no tracklist reload).
      if (sel && byAlbum.has(sel.id)) Object.assign(sel, byAlbum.get(sel.id));
    }

    player.patchTracks(patchFor);
    this.tick += 1;
    if (opts.broadcast !== false) broadcastLibraryChange(change);
  }

  /** A new cover was saved for an album: every view and the player follow. */
  noteAlbumCoverChanged(albumId: number, version?: string | number | null) {
    const v = version != null && version !== "" ? version : Date.now();
    this.applyLibraryChange({ albums: [{ id: albumId, has_cover: true, cover_version: v }] });
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
      const artist = this.selectedArtist;
      this.selectedAlbum = null;
      this.tracks = [];
      this.libraryLevel = "artist";
      try {
        this.albums = await api.artistAlbums(artist.id);
      } catch (e) {
        this.albums = this.allAlbums.filter((a) => a.artist_id === artist.id);
        toasts.fail(e);
      }
      return;
    }
    if (this.libraryLevel === "search") {
      this.query = "";
      this.libraryLevel = "artists";
      this.tracks = [];
      await this.quiet(this.loadArtists());
      return;
    }
    this.libraryLevel = "artists";
    this.selectedArtist = null;
    this.selectedAlbum = null;
    this.albums = [];
    this.tracks = [];
    await this.quiet(this.loadArtists());
  }

  /** Catalog search index, rebuilt only when the catalog list changes. */
  private searchIndex(): SearchIndex<Track> | null {
    const tracks = this.catalogTracks;
    if (!tracks.length) return null;
    const cached = this.searchIndexCache;
    if (cached && cached.tracks === tracks) return cached.index;
    const index = buildSearchIndex(tracks);
    this.searchIndexCache = { tracks, index };
    return index;
  }

  /**
   * Track search: title (without its "01 - " number prefix), artist, album
   * and genres — never file paths. From the catalog when it is loaded (no
   * request, instant); otherwise the hub's search, filtered the same way.
   */
  async searchLibrary() {
    const q = this.query.trim();
    this.view = "library";
    if (!q) {
      this.libraryLevel = "artists";
      this.tracks = [];
      await this.quiet(this.loadArtists());
      return;
    }
    this.libraryLevel = "search";
    this.selectedArtist = null;
    this.selectedAlbum = null;
    const index = this.searchIndex();
    if (index) {
      this.tracks = searchTracks(index, q, 500);
      return;
    }
    try {
      // Hub full-text search (same rules); older hubs answer the bare list.
      const res = (await api.searchAll(q)) as unknown;
      if (this.query.trim() !== q) return;
      const found = Array.isArray(res) ? (res as Track[]) : ((res as { tracks?: Track[] }).tracks ?? []);
      this.tracks = found.filter((tr) => trackMatchesQuery(tr, q));
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

  /** Artists whose name, or the genre of one of their tracks, matches. */
  matchArtists(q: string) {
    const n = q.trim();
    if (!n) return [];
    const index = this.searchIndex();
    const low = n.toLowerCase();
    return this.artists.filter(
      (a) =>
        a.name.toLowerCase().includes(low) ||
        (index != null && index.artistGenreMatches(a.name, n)),
    );
  }

  /** Albums whose name, artist or genre (album or its tracks) matches. */
  matchAlbums(q: string) {
    const n = q.trim();
    if (!n) return [];
    const index = this.searchIndex();
    const low = n.toLowerCase();
    return this.allAlbums.filter(
      (a) =>
        a.name.toLowerCase().includes(low) ||
        a.artist_name.toLowerCase().includes(low) ||
        (index != null ? index.albumGenreMatches(a, n) : false),
    );
  }

  async loadFavorites() {
    await this.shared(
      "favorites",
      () => api.favorites(),
      (v) => {
        this.favorites = v;
        this.favoriteIds = new Set(v.map((track) => track.id));
      },
    );
  }

  async loadPlaylists() {
    await this.shared("playlists", () => api.playlists(), (v) => (this.playlists = v));
  }

  async openPlaylist(id: string) {
    // Another playlist's tracks must not show (or play) under this name.
    if (this.activePlaylistId !== id) this.playlistTracks = [];
    this.activePlaylistId = id;
    try {
      const data = await api.playlistTracks(id);
      if (this.activePlaylistId === id) this.playlistTracks = data.tracks;
    } catch (e) {
      toasts.fail(e);
    }
  }

  /**
   * Background loads started by navigation: a failure is already visible
   * (offline banner, empty list), an unhandled rejection is not useful.
   */
  private async quiet(task: Promise<unknown>) {
    try {
      await task;
    } catch {
      /* see the connection banner */
    }
  }

  saveServer() {
    setServerBaseUrl(this.serverUrl);
    void this.refreshAll();
  }

  setCrossfade(sec: CrossfadeSec) {
    player.setCrossfadeSec(sec);
    this.crossfadeSec = sec;
  }

  /**
   * Optimistic: the heart flips at once, the hub confirms after. On failure
   * only this track goes back (other toggles made meanwhile stay).
   */
  async toggleFavorite(track: Track) {
    // Podcast episodes / live streams are not library tracks.
    if (isExternalTrack(track)) return;
    if (this.favoriteBusy.has(track.id)) return;
    const wasFavorite = this.favoriteIds.has(track.id);
    this.favoriteBusy.add(track.id);
    this.setFavoriteLocal(track, !wasFavorite);
    try {
      if (wasFavorite) await api.removeFavorite(track.id);
      else await api.addFavorite(track.id);
    } catch (e) {
      this.setFavoriteLocal(track, wasFavorite);
      toasts.error(
        t(wasFavorite ? "core.favorites.removeFailed" : "core.favorites.addFailed", {
          title: track.title,
          error: describeError(e),
        }),
      );
    } finally {
      this.favoriteBusy.delete(track.id);
    }
  }

  private setFavoriteLocal(track: Track, favorite: boolean) {
    const ids = new Set(this.favoriteIds);
    if (favorite) {
      ids.add(track.id);
      // Hub order is newest first.
      if (!this.favorites.some((f) => f.id === track.id)) {
        this.favorites = [track, ...this.favorites];
      }
    } else {
      ids.delete(track.id);
      this.favorites = this.favorites.filter((f) => f.id !== track.id);
    }
    this.favoriteIds = ids;
  }

  async toggleFavoriteCurrent() {
    const track = this.current;
    if (!track) return;
    await this.toggleFavorite(track);
  }

  toggleExcludeCurrent() {
    const track = this.current;
    if (!track || isExternalTrack(track)) return;
    player.toggleExcludeTrack(track);
  }

  /** Name for messages; the id is never something to show the user. */
  private playlistName(id: string): string {
    return this.playlists.find((p) => p.id === id)?.name ?? "";
  }

  private bumpPlaylistCount(id: string, delta: number) {
    this.playlists = this.playlists.map((p) =>
      p.id === id ? { ...p, track_count: Math.max(0, p.track_count + delta) } : p,
    );
  }

  async createPlaylist() {
    const name = this.newPlaylistName.trim();
    if (!name) return;
    let pl: Playlist;
    try {
      pl = await api.createPlaylist(name);
    } catch (e) {
      toasts.error(t("core.playlists.createFailed", { playlist: name, error: describeError(e) }));
      return;
    }
    this.newPlaylistName = "";
    await this.quiet(this.loadPlaylists());
    await this.openPlaylist(pl.id);
    toasts.ok(t("toast.playlistCreated", { playlist: name }));
  }

  /** Optimistic rename; the old name comes back if the hub refuses. */
  async renamePlaylist(id: string, name: string) {
    const next = name.trim();
    const before = this.playlistName(id);
    if (!next || next === before) return;
    this.playlists = this.playlists.map((p) => (p.id === id ? { ...p, name: next } : p));
    try {
      await api.renamePlaylist(id, next);
    } catch (e) {
      this.playlists = this.playlists.map((p) =>
        p.id === id && p.name === next ? { ...p, name: before } : p,
      );
      toasts.error(t("core.playlists.renameFailed", { playlist: before, error: describeError(e) }));
    }
  }

  async deletePlaylist(id: string) {
    const name = this.playlistName(id);
    try {
      await api.deletePlaylist(id);
    } catch (e) {
      toasts.error(t("core.playlists.deleteFailed", { playlist: name, error: describeError(e) }));
      return;
    }
    if (this.activePlaylistId === id) {
      this.activePlaylistId = null;
      this.playlistTracks = [];
    }
    this.playlists = this.playlists.filter((p) => p.id !== id);
    void this.quiet(this.loadPlaylists());
    toasts.ok(t("toast.playlistDeleted", { playlist: name }));
  }

  async addToPlaylist(playlistId: string, trackId: number) {
    const name = this.playlistName(playlistId);
    try {
      await api.addToPlaylist(playlistId, trackId);
    } catch (e) {
      toasts.error(t("core.playlists.addFailed", { playlist: name, error: describeError(e) }));
      return;
    }
    this.bumpPlaylistCount(playlistId, 1);
    if (this.activePlaylistId === playlistId) await this.openPlaylist(playlistId);
    toasts.ok(t("toast.playlistAdded", { playlist: name }));
  }

  async addCurrentToPlaylist(playlistId: string) {
    const track = this.current;
    if (!track) return;
    await this.addToPlaylist(playlistId, track.id);
  }

  /** Optimistic: the row goes at once and comes back if the hub refuses. */
  async removeFromPlaylist(playlistId: string, trackId: number) {
    const name = this.playlistName(playlistId);
    const shown = this.activePlaylistId === playlistId;
    const before = this.playlistTracks;
    if (shown) {
      // The same track can sit in a playlist twice; the hub removes one.
      const i = before.findIndex((tr) => tr.id === trackId);
      if (i >= 0) this.playlistTracks = before.filter((_, j) => j !== i);
    }
    try {
      await api.removeFromPlaylist(playlistId, trackId);
    } catch (e) {
      if (shown && this.activePlaylistId === playlistId) this.playlistTracks = before;
      toasts.error(t("core.playlists.removeFailed", { playlist: name, error: describeError(e) }));
      return;
    }
    this.bumpPlaylistCount(playlistId, -1);
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

  /**
   * The hub has no bulk insert: tracks go one by one, in queue order. A track
   * that fails does not stop the rest; the toast says how many made it.
   */
  async saveQueueAsPlaylist() {
    const name = this.queuePlaylistName.trim() || t("core.queueSave.defaultName");
    const queue = player.queue.slice();
    if (!queue.length) return;
    let pl: Playlist;
    try {
      pl = await api.createPlaylist(name);
    } catch (e) {
      toasts.error(t("core.playlists.createFailed", { playlist: name, error: describeError(e) }));
      return;
    }
    const job = queue.length > 20 ? toasts.busy(t("core.queueSave.busy", { playlist: name })) : null;
    let added = 0;
    let firstError: unknown = null;
    for (const [i, track] of queue.entries()) {
      try {
        await api.addToPlaylist(pl.id, track.id);
        added += 1;
      } catch (e) {
        firstError ??= e;
        // Hub gone: the remaining requests would only fail the same way.
        if (isOfflineError(e)) break;
      }
      if (job && i % 10 === 9) {
        job.update(t("core.queueSave.progress", { done: i + 1, total: queue.length }));
      }
    }
    this.queuePlaylistName = "";
    await this.quiet(this.loadPlaylists());
    this.view = "playlists";
    await this.openPlaylist(pl.id);
    if (firstError == null) {
      const message = t("toast.queueSaved", { playlist: name, tracks: added });
      if (job) job.done(message);
      else toasts.ok(message);
    } else {
      const message = t("core.queueSave.partial", {
        playlist: name,
        added,
        total: queue.length,
        error: describeError(firstError),
      });
      if (job) job.done(message, "error");
      else toasts.error(message);
    }
  }

  navigate(id: ViewId) {
    this.view = id;
    // Dashboard: no refreshAll — that pulled user-state / legacyQueue and could
    // stop or replace the playing track. Data sync is TopBar Refresh only.
    if (id === "library" && this.libraryLevel === "artists") void this.quiet(this.loadArtists());
    if (id === "favorites") void this.quiet(this.loadFavorites());
    if (id === "playlists") void this.quiet(this.loadPlaylists());
    if (id === "statistics" || id === "achievements") {
      void this.ensureCatalogTracks();
      if (!this.favorites.length) void this.quiet(this.loadFavorites());
      if (!this.playlists.length) void this.quiet(this.loadPlaylists());
      if (!this.allAlbums.length) void this.quiet(this.loadAllAlbums());
      if (!this.artists.length) void this.quiet(this.loadArtists());
    }
  }

  /** Open Settings on a tab: "Apri Impostazioni" buttons land where the fix is. */
  openSettings(target: SettingsTarget) {
    this.settingsTarget = target;
    this.navigate("settings");
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
    await this.quiet(this.loadArtists());
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
        void this.quiet(this.loadPlaylists());
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

  /** Album / playlist: queue ordered from the track (or from the start). */
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

  /** Smart radio from a seed over the library (or a given pool). */
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
    const artist = this.selectedArtist;
    if (!artist) return;
    try {
      const albums = this.albums.length ? this.albums : await api.artistAlbums(artist.id);
      // Albums that fail to load just sit this shuffle out.
      const lists = await Promise.allSettled(albums.map((a) => api.albumTracks(a.id)));
      const all = lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      if (!all.length) {
        const failed = lists.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
        return;
      }
      this.playPoolShuffle(all);
    } catch (e) {
      toasts.fail(e);
    }
  }

  async shuffleLibrary() {
    const tracks = await this.ensureCatalogTracks();
    this.playPoolShuffle(tracks);
  }

  async radioFromCurrent() {
    const cur = this.current;
    if (!cur || isExternalTrack(cur)) return;
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

/** 4xx other than timeout / conflict / rate limit: retrying cannot help. */
function isPermanentRejection(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.kind === "http" &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 409 &&
    e.status !== 429
  );
}

/** Last state this client and the hub agreed on, per account (shared by tabs). */
type SyncBase = {
  revision: number | null;
  fields: SyncedUserFields;
  /** State a push sent whose answer has not come back (see `agreedBase`). */
  inflight?: SyncedUserFields | null;
};

const SYNC_BASE_PREFIX = "rekord.next.userStateSync.";
const SYNCED_SETTINGS_PREFIX = "rekord.next.syncedSettings.";

function accountKey(): string {
  return (getSelectedAccountId() || "").trim() || "default";
}

/**
 * Kept in localStorage, not in memory: tabs share the prefs, so they must
 * share what "already on the hub" means too, or one tab's pushed plays would
 * be counted again by the other on a conflict.
 */
function loadSyncBase(account: string): SyncBase | null {
  try {
    const raw = localStorage.getItem(SYNC_BASE_PREFIX + account);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { revision?: unknown; fields?: unknown; inflight?: unknown };
    const revision = Number(parsed.revision);
    return {
      revision: parsed.revision != null && Number.isFinite(revision) ? revision : null,
      fields: syncedFieldsOf(parsed.fields as Record<string, unknown>),
      inflight:
        parsed.inflight && typeof parsed.inflight === "object"
          ? syncedFieldsOf(parsed.inflight as Record<string, unknown>)
          : null,
    };
  } catch {
    return null;
  }
}

function saveSyncBase(account: string, base: SyncBase) {
  try {
    localStorage.setItem(SYNC_BASE_PREFIX + account, JSON.stringify(base));
  } catch {
    /* quota: the in-memory copy still works for this tab */
  }
}

function loadSyncedSettingsCache(account: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SYNCED_SETTINGS_PREFIX + account);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function saveSyncedSettingsCache(account: string, settings: Record<string, unknown>) {
  try {
    localStorage.setItem(SYNCED_SETTINGS_PREFIX + account, JSON.stringify(settings));
  } catch {
    /* ignore: the hub has the real copy */
  }
}

function fieldsFromPrefs(p: UserPrefs): SyncedUserFields {
  return {
    playCounts: p.playCounts,
    recentRelPaths: p.recentRelPaths,
    trackMoods: p.trackMoods,
    excludedRelPaths: p.excludedRelPaths,
    excludedAlbumIds: p.excludedAlbumIds,
  };
}

function settingsFromPrefs(p: UserPrefs): Record<string, unknown> {
  return {
    crossfadeSec: p.crossfadeSec,
    theme: p.theme,
    customTheme: p.customTheme,
    glassSurfaces: p.glassSurfaces,
    glassOpacity: p.glassOpacity,
    locale: p.locale,
    visualizerMode: p.visualizerMode,
  };
}

/** Hub `settings` → prefs patch, skipping keys edited locally (`keep`). */
function prefsPatchFromSettings(
  settings: Record<string, unknown>,
  keep: Set<string>,
): Partial<UserPrefs> {
  const patch: Partial<UserPrefs> = {};
  const themeRaw = settings.theme;
  const crossfadeRaw = settings.crossfadeSec ?? settings.audioCrossfadeSec;
  const vizRaw = settings.visualizerMode ?? settings.vizMode;
  const localeRaw = settings.locale;
  if (!keep.has("theme") && typeof themeRaw === "string" && themeRaw.trim()) {
    patch.theme = normalizeTheme(themeRaw);
  }
  if (
    !keep.has("customTheme") &&
    settings.customTheme &&
    typeof settings.customTheme === "object"
  ) {
    patch.customTheme = normalizeCustomTheme(settings.customTheme as Record<string, unknown>);
  }
  if (!keep.has("glassSurfaces") && typeof settings.glassSurfaces === "boolean") {
    patch.glassSurfaces = settings.glassSurfaces;
  }
  if (
    !keep.has("glassOpacity") &&
    settings.glassOpacity != null &&
    Number.isFinite(Number(settings.glassOpacity))
  ) {
    patch.glassOpacity = normalizeGlassOpacity(settings.glassOpacity);
  }
  if (!keep.has("locale") && (localeRaw === "en" || localeRaw === "it" || localeRaw === "de")) {
    patch.locale = normalizeLocale(localeRaw);
  }
  if (
    !keep.has("crossfadeSec") &&
    (crossfadeRaw === 0 ||
      crossfadeRaw === 3 ||
      crossfadeRaw === 5 ||
      crossfadeRaw === 8 ||
      crossfadeRaw === 12)
  ) {
    patch.crossfadeSec = (
      crossfadeRaw === 8 || crossfadeRaw === 12 ? 5 : crossfadeRaw
    ) as CrossfadeSec;
  }
  if (!keep.has("visualizerMode") && typeof vizRaw === "string" && vizRaw.trim()) {
    patch.visualizerMode = normalizeVisualizerMode(vizRaw);
  }
  return patch;
}

// `?accountId=` deep link: bound before any request or prefs read.
applyAccountDeepLink();

export const session = new ClientSession();
