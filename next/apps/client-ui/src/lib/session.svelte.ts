import {
  getSelectedAccountId,
  setSelectedAccountId,
} from "./account";
import {
  api,
  type Album,
  type Artist,
  type LibraryStats,
  type Playlist,
  type Track,
} from "./api";
import { getServerBaseUrl, setServerBaseUrl } from "./config";
import { i18n } from "./i18n.svelte";
import { player } from "./player";
import { normalizeCustomTheme } from "./themeCatalog";
import {
  applyTheme,
  loadUserPrefs,
  migratePrefsToRelPaths,
  normalizeLocale,
  normalizeTheme,
  patchUserPrefs,
  setUserPrefsChangeListener,
  type CrossfadeSec,
  type VisualizerMode,
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

  selectedArtist = $state<Artist | null>(null);
  selectedAlbum = $state<Album | null>(null);
  editDialog = $state<EditDialog>("none");
  editTrack = $state<Track | null>(null);

  query = $state("");
  serverUrl = $state(getServerBaseUrl());
  status = $state("");
  error = $state("");
  newPlaylistName = $state("");
  queuePlaylistName = $state("");
  crossfadeSec = $state<CrossfadeSec>(loadUserPrefs().crossfadeSec);
  tick = $state(0);

  readonly current = $derived.by(() => {
    this.tick;
    return player.current;
  });
  readonly playing = $derived.by(() => {
    this.tick;
    return player.playing;
  });
  readonly currentTime = $derived.by(() => {
    this.tick;
    return player.currentTime;
  });
  readonly duration = $derived.by(() => {
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

  /** Titolo topbar: solo nome sezione di navigazione (mai album/artista/query). */
  readonly pageTitle = $derived.by(() => {
    switch (this.view) {
      case "dashboard":
        return "Dashboard";
      case "studio":
        return "Studio";
      case "plectr":
        return "Plectr";
      case "favorites":
        return "Preferiti";
      case "playlists":
        return "Playlist";
      case "queue":
        return "Coda";
      case "recent":
        return "Recenti";
      case "statistics":
        return "Statistiche";
      case "achievements":
        return "Achievements";
      case "settings":
        return "Impostazioni";
      case "library":
        return "Libreria";
      default:
        return "RE-KORD";
    }
  });


  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight = false;
  private pushAgain = false;
  private userStateDirty = false;
  private suppressUserStatePush = false;
  private prefsListenerBound = false;

  private ensurePrefsSync() {
    if (this.prefsListenerBound) return;
    this.prefsListenerBound = true;
    setUserPrefsChangeListener(() => {
      if (this.suppressUserStatePush) return;
      this.userStateDirty = true;
      this.pushUserStateDebounced();
    });
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
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      unsub();
    };
  }

  readonly albumsWithoutCover = $derived(
    this.allAlbums.filter((a) => !a.has_cover).length,
  );

  async pullUserState() {
    this.ensurePrefsSync();
    // Flush only pending local edits — never push pristine defaults over remote.
    if (this.userStateDirty || this.pushTimer != null) {
      await this.flushUserStatePush();
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
        trackMoods: {
          ...local.trackMoods,
          ...(remote.trackMoods as Record<string, string[]>),
        },
        excludedRelPaths: remote.excludedRelPaths?.length
          ? remote.excludedRelPaths
          : local.excludedRelPaths,
        excludedAlbumIds: remote.excludedAlbumIds?.length
          ? remote.excludedAlbumIds
          : local.excludedAlbumIds,
      };
      if (typeof themeRaw === "string" && themeRaw.trim()) {
        patch.theme = normalizeTheme(themeRaw);
      }
      if (settings.customTheme && typeof settings.customTheme === "object") {
        patch.customTheme = normalizeCustomTheme(
          settings.customTheme as Record<string, unknown>,
        );
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
        this.crossfadeSec = patch.crossfadeSec;
        player.setCrossfadeSec(patch.crossfadeSec);
      }
      if (typeof vizRaw === "string" && vizRaw.trim()) {
        patch.visualizerMode = vizRaw as VisualizerMode;
      }
      patchUserPrefs(patch);
      applyTheme(
        patch.theme ?? local.theme,
        patch.customTheme ?? local.customTheme,
      );
      i18n.applySaved();
      player.reloadExclusionsFromPrefs();
      this.pendingLegacyQueue = settings.legacyQueue as
        | { relPaths?: string[]; currentIndex?: number }
        | null;
      this.moodPrefsTick += 1;
    } catch {
      /* server may be older / offline */
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
    if (!q?.relPaths?.length || !this.catalogTracks.length) return;
    player.hydrateQueueFromRelPaths(
      q.relPaths.filter((p): p is string => typeof p === "string" && !!p),
      typeof q.currentIndex === "number" ? q.currentIndex : 0,
      this.catalogTracks,
    );
    this.pendingLegacyQueue = null;
  }

  pushUserStateDebounced() {
    this.ensurePrefsSync();
    if (this.suppressUserStatePush) return;
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
    if (!this.userStateDirty && !this.pushAgain) return;
    if (this.pushInFlight) {
      this.pushAgain = true;
      return;
    }
    this.pushInFlight = true;
    try {
      const p = loadUserPrefs();
      await api.patchUserState({
        playCounts: p.playCounts,
        recentRelPaths: p.recentRelPaths,
        trackMoods: p.trackMoods,
        excludedRelPaths: p.excludedRelPaths,
        excludedAlbumIds: p.excludedAlbumIds,
        settings: {
          crossfadeSec: p.crossfadeSec,
          theme: p.theme,
          customTheme: p.customTheme,
          locale: p.locale,
          visualizerMode: p.visualizerMode,
        },
      });
      this.userStateDirty = false;
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

  async refreshAll() {
    this.status = "…";
    this.error = "";
    try {
      await api.health();
      await Promise.all([
        this.loadStats(),
        this.loadArtists(),
        this.loadAllAlbums(),
        this.loadFavorites(),
        this.loadPlaylists(),
        this.loadCatalogTracks(),
        this.pullUserState(),
      ]);
      // Remap prefs that used SQLite ids before the last catalog wipe/rescan.
      if (this.catalogTracks.length) {
        migratePrefsToRelPaths(this.catalogTracks);
        player.reloadExclusionsFromPrefs();
        this.applyPendingLegacyQueue();
      }
      this.status = this.stats?.scanning ? "indexing" : "online";
    } catch (e) {
      this.status = "offline";
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Soft switch: no full page reload — reload selection, prefs, favorites/playlists. */
  async switchAccount(accountId: string) {
    if (!accountId || accountId === getSelectedAccountId()) return;
    // Persist the outgoing account before the storage key changes.
    if (this.userStateDirty || this.pushTimer != null) {
      await this.flushUserStatePush();
    }
    setSelectedAccountId(accountId);
    const prefs = loadUserPrefs(accountId);
    applyTheme(prefs.theme, prefs.customTheme);
    this.crossfadeSec = prefs.crossfadeSec;
    player.setCrossfadeSec(prefs.crossfadeSec);
    player.reloadExclusionsFromPrefs();
    this.activePlaylistId = null;
    this.playlistTracks = [];
    this.selectedArtist = null;
    this.selectedAlbum = null;
    this.libraryLevel = "artists";
    this.moodPrefsTick += 1;
    i18n.applySaved();
    await this.refreshAll();
  }

  /**
   * Boot: wait for the hub (and optional background first-scan) so the UI
   * does not stick on an empty library / missing covers after a cold start.
   * Session queue restore is always on (queue + currentIndex only).
   */
  async bootstrap(maxWaitMs = 90_000) {
    this.ensurePrefsSync();
    try {
      await api.ensureAccountSession();
    } catch {
      /* offline / first paint — retry via refreshAll */
    }
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

  async loadArtists() {
    this.artists = await api.artists();
  }

  async loadAllAlbums() {
    this.allAlbums = await api.albums();
  }

  async loadCatalogTracks() {
    this.catalogTracks = await api.tracks(2000);
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
      this.error = "";
      const album = await api.album(track.album_id);
      this.selectedAlbum = album;
      this.editDialog = "cover";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
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
      this.error = e instanceof Error ? e.message : String(e);
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
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async openLibraryForTrack(track: Track) {
    try {
      this.error = "";
      if (track.artist_id != null) {
        const artist = await api.artist(track.artist_id);
        await this.openArtist(artist);
      }
      if (track.album_id != null) {
        const album = await api.album(track.album_id);
        await this.openAlbum(album);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async openLibraryArtist(track: Track) {
    if (track.artist_id == null) return;
    try {
      this.error = "";
      const artist = await api.artist(track.artist_id);
      await this.openArtist(artist);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
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
      this.error = "";
      this.tracks = await api.search(q);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
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
    return this.artists.filter((a) => a.name.toLowerCase().includes(n)).slice(0, 12);
  }

  matchAlbums(q: string) {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return this.allAlbums
      .filter(
        (a) =>
          a.name.toLowerCase().includes(n) || a.artist_name.toLowerCase().includes(n),
      )
      .slice(0, 12);
  }

  async loadFavorites() {
    this.favorites = await api.favorites();
    this.favoriteIds = new Set(this.favorites.map((t) => t.id));
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

  async createPlaylist() {
    const name = this.newPlaylistName.trim();
    if (!name) return;
    const pl = await api.createPlaylist(name);
    this.newPlaylistName = "";
    await this.loadPlaylists();
    await this.openPlaylist(pl.id);
  }

  async renamePlaylist(id: string, name: string) {
    await api.renamePlaylist(id, name);
    await this.loadPlaylists();
  }

  async deletePlaylist(id: string) {
    await api.deletePlaylist(id);
    if (this.activePlaylistId === id) {
      this.activePlaylistId = null;
      this.playlistTracks = [];
    }
    await this.loadPlaylists();
  }

  async addToPlaylist(playlistId: string, trackId: number) {
    await api.addToPlaylist(playlistId, trackId);
    await this.loadPlaylists();
    if (this.activePlaylistId === playlistId) await this.openPlaylist(playlistId);
  }

  async addCurrentToPlaylist(playlistId: string) {
    const t = this.current;
    if (!t) return;
    await this.addToPlaylist(playlistId, t.id);
  }

  async removeFromPlaylist(playlistId: string, trackId: number) {
    await api.removeFromPlaylist(playlistId, trackId);
    await this.loadPlaylists();
    if (this.activePlaylistId === playlistId) await this.openPlaylist(playlistId);
  }

  async saveQueueAsPlaylist() {
    const name = this.queuePlaylistName.trim() || "Coda salvata";
    const pl = await api.createPlaylist(name);
    for (const t of player.queue) {
      await api.addToPlaylist(pl.id, t.id);
    }
    this.queuePlaylistName = "";
    await this.loadPlaylists();
    this.view = "playlists";
    await this.openPlaylist(pl.id);
  }

  navigate(id: ViewId) {
    this.view = id;
    if (id === "dashboard") void this.refreshAll();
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

  playTrack(track: Track, list: Track[]) {
    player.playTrack(track, list);
  }

  playAll(list: Track[]) {
    if (!list.length) return;
    player.playTracks(list, 0);
  }

  playShuffled(list: Track[], start?: Track) {
    player.playShuffled(list, start);
  }

  async shuffleArtist() {
    if (!this.selectedArtist) return;
    const albums = this.albums.length
      ? this.albums
      : await api.artistAlbums(this.selectedArtist.id);
    const lists = await Promise.all(albums.map((a) => api.albumTracks(a.id)));
    const all = lists.flat();
    this.playShuffled(all);
  }

  async shuffleLibrary() {
    const tracks = await this.ensureCatalogTracks();
    this.playShuffled(tracks);
  }

  async radioFromCurrent() {
    const cur = this.current;
    if (!cur) return;
    const library = await this.ensureCatalogTracks();
    player.playRadioFromSeed(cur, library);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export const session = new ClientSession();
