<script lang="ts">
  import {
    ActionRow,
    Button,
    Field,
    Panel,
    Select,
    TextInput,
  } from "@rekord/ui";
  import AccountList from "../components/AccountList.svelte";
  import AccountRow from "../components/AccountRow.svelte";
  import DiskSpaceMeter from "../components/DiskSpaceMeter.svelte";
  import IntegrationList from "../components/IntegrationList.svelte";
  import IntegrationRow from "../components/IntegrationRow.svelte";
  import RemoteAccessPanel from "../components/RemoteAccessPanel.svelte";
  import SectionNavTabs from "../components/SectionNavTabs.svelte";
  import SettingsFieldsGrid from "../components/SettingsFieldsGrid.svelte";
  import ShortcutList from "../components/ShortcutList.svelte";
  import ThemePicker from "../components/ThemePicker.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import {
    getSelectedAccountId,
    type AccountsResponse,
  } from "../lib/account";
  import type { ShortcutItem } from "../lib/shortcutList";
  import { session } from "../lib/session.svelte";
  import {
    api,
    formatBytes,
    type HubConfig,
    type RemoteAccessState,
    type Track,
  } from "../lib/api";
  import {
    buildAchievementsSnapshot,
    titleForNumericLevel,
  } from "../lib/achievements";
  import {
    applyLegacyUserState,
    pickUserStateFromKordFolder,
    type LegacyImportReport,
  } from "../lib/legacyImport";
  import { i18n, t } from "../lib/i18n.svelte";
  import { trackGenre } from "../lib/trackMoods";
  import {
    VISUALIZER_MODES,
    applyTheme,
    loadUserPrefs,
    normalizeGlassOpacity,
    normalizeTheme,
    patchUserPrefs,
    syncGlassSurfaceDom,
    type CrossfadeSec,
    type CustomThemeSettings,
    type UiTheme,
    type VisualizerMode,
  } from "../lib/userPrefs";
  import { APP_VERSION } from "../lib/version";

  const fadeOptions = $derived([
    { value: "0", label: t("settings.audioCrossfadeOff") },
    { value: "3", label: t("settings.audioCrossfade3") },
    { value: "5", label: t("settings.audioCrossfade5") },
  ]);

  const languageOptions = $derived([
    { value: "it", label: t("settings.langIt") },
    { value: "en", label: t("settings.langEn") },
  ]);

  // Stable section ids (Italian) — labels are translated.
  const settingsTabs = $derived([
    { id: "Account", label: t("settings.tab.account") },
    { id: "Interfaccia", label: t("settings.tab.ui") },
    { id: "Libreria", label: t("settings.tab.library") },
    { id: "Rete", label: t("settings.tab.network") },
    { id: "Sistema", label: t("settings.tab.system") },
  ]);

  let fadeValue = $state(String(session.crossfadeSec));
  let localeValue = $state(i18n.locale);
  let themeValue = $state(loadUserPrefs().theme);
  let customThemeValue = $state(loadUserPrefs().customTheme);
  let glassSurfaces = $state(loadUserPrefs().glassSurfaces);
  let glassOpacityDraft = $state(loadUserPrefs().glassOpacity);
  let glassOpacityTimer: ReturnType<typeof setTimeout> | null = null;
  let customThemeDialogOpen = $state(false);
  let section = $state("Interfaccia");

  let accounts = $state<AccountsResponse | null>(null);
  let selectedAccountId = $state(getSelectedAccountId() || "default");
  let newAccountName = $state("");
  let accountBusy = $state(false);
  let accountErr = $state("");
  let accountOk = $state("");
  /** accountId → numeric level (legacy account-row pill) */
  let accountLevels = $state<Record<string, number>>({});

  let importBusy = $state(false);
  let importPhase = $state("");
  let importError = $state("");
  let importReport = $state<LegacyImportReport | null>(null);
  let importSource = $state("");
  let kordDirInput: HTMLInputElement | undefined = $state();

  let backupBusy = $state(false);
  let restoreBusy = $state(false);
  let backupOk = $state("");
  let backupErr = $state("");
  let restoreOk = $state("");
  let restoreErr = $state("");
  let restoreFileInput: HTMLInputElement | undefined = $state();

  let themeImportBusy = $state(false);
  let themeExportBusy = $state(false);
  let themeImportOk = $state("");
  let themeImportErr = $state("");
  let themeExportOk = $state("");
  let themeExportErr = $state("");
  let themeImportInput: HTMLInputElement | undefined = $state();

  let hubConfig = $state<HubConfig | null>(null);
  let integBusy = $state(false);
  let integErr = $state("");
  let integOk = $state("");
  let discogsDraft = $state("");
  let cookiesInput: HTMLInputElement | undefined = $state();
  let vizValue = $state(loadUserPrefs().visualizerMode);
  let remoteBusy = $state(false);
  let remoteInfo = $state<RemoteAccessState | null>(null);
  let remoteErr = $state("");
  let remoteUrlCopyOk = $state("");
  let remoteUrlCopyTimer: number | null = null;
  let remotePollTimer: number | null = null;
  let diag = $state<Awaited<ReturnType<typeof api.diagnostics>> | null>(null);
  let activityEntries = $state<Array<{ ts: string; kind: string; message: string }>>([]);
  let activityBusy = $state(false);
  let activityErr = $state("");
  let activityLoaded = $state(false);

  const vizLabelKeys: Record<(typeof VISUALIZER_MODES)[number], string> = {
    bars: "settings.vizBars",
    mirror: "settings.vizMirror",
    osc: "settings.vizOsc",
    oscSoft: "settings.vizOscSoft",
    hmb: "settings.vizHmb",
    signals: "settings.vizSignals",
    karaoke: "settings.vizKaraoke",
  };

  const vizOptions = $derived(
    VISUALIZER_MODES.map((id) => ({
      value: id,
      label: t(vizLabelKeys[id]),
    })),
  );

  const shortcutItems = $derived<ShortcutItem[]>([
    {
      id: "search",
      keys: [
        { text: "/", size: "solo" },
        { text: t("settings.kbdCtrlK") },
      ],
      keySep: t("settings.shortcutOr"),
      description: t("settings.shortcutSearchDesc"),
    },
    {
      id: "play",
      keys: [{ text: t("settings.kbdSpace"), size: "wide" }],
      description: t("settings.shortcutPlayDesc"),
    },
    {
      id: "seek",
      keys: [
        { text: t("settings.kbdArrowLeft"), size: "solo" },
        { text: t("settings.kbdArrowRight"), size: "solo" },
      ],
      keySep: "/",
      description: t("settings.shortcutSeekDesc"),
    },
    {
      id: "listen",
      keys: [{ text: t("settings.kbdI"), size: "solo" }],
      description: t("settings.shortcutListenDesc"),
    },
  ]);

  function selectValue(ev: Event): string {
    return (ev.currentTarget as HTMLSelectElement).value;
  }

  async function loadHubConfig() {
    try {
      hubConfig = await api.config();
    } catch {
      hubConfig = null;
    }
  }

  async function loadRemote() {
    try {
      remoteInfo = await api.remoteAccess();
      if (remoteInfo.status !== "error") remoteErr = "";
      else if (remoteInfo.error) remoteErr = remoteInfo.error;
    } catch (e) {
      remoteInfo = null;
      remoteErr = e instanceof Error ? e.message : String(e);
    }
  }

  async function remoteLogin() {
    remoteBusy = true;
    remoteErr = "";
    try {
      const d = await api.remoteLogin();
      if (d.loginUrl) window.open(d.loginUrl, "_blank", "noopener,noreferrer");
      await loadRemote();
    } catch (e) {
      remoteErr = e instanceof Error ? e.message : String(e);
    } finally {
      remoteBusy = false;
    }
  }

  async function remoteLogout() {
    remoteBusy = true;
    remoteErr = "";
    try {
      remoteInfo = await api.remoteLogout();
    } catch (e) {
      remoteErr = e instanceof Error ? e.message : String(e);
    } finally {
      remoteBusy = false;
    }
  }

  async function remoteToggleShare() {
    remoteBusy = true;
    remoteErr = "";
    try {
      const running =
        remoteInfo?.status === "running" || remoteInfo?.status === "starting";
      remoteInfo = running ? await api.remoteStop() : await api.remoteStart();
      if (remoteInfo.error) remoteErr = remoteInfo.error;
    } catch (e) {
      remoteErr = e instanceof Error ? e.message : String(e);
      await loadRemote();
    } finally {
      remoteBusy = false;
    }
  }

  async function copyRemoteUrl(url: string) {
    const value = url.trim();
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("copy failed");
      }
      if (remoteUrlCopyTimer != null) window.clearTimeout(remoteUrlCopyTimer);
      remoteUrlCopyOk = t("settings.remoteUrlCopied");
      remoteUrlCopyTimer = window.setTimeout(() => {
        remoteUrlCopyOk = "";
        remoteUrlCopyTimer = null;
      }, 4000);
    } catch {
      remoteErr = t("settings.remoteUrlCopyFailed");
    }
  }

  async function loadDiag() {
    try {
      diag = await api.diagnostics();
    } catch {
      diag = null;
    }
  }

  async function loadActivity() {
    activityBusy = true;
    activityErr = "";
    try {
      const res = await api.activityLog();
      activityEntries = res.entries || [];
    } catch (e) {
      activityEntries = [];
      activityErr = e instanceof Error ? e.message : String(e);
    } finally {
      activityLoaded = true;
      activityBusy = false;
    }
  }

  function formatActivityTs(ts: string): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts || "—";
    return d.toLocaleString(i18n.sortLocale, {
      dateStyle: "short",
      timeStyle: "medium",
    });
  }

  function activityKindClass(kind: string): string {
    const k = kind.trim().toLowerCase();
    if (k === "error" || k === "err" || k === "fail") return "activity-log-kind--err";
    if (k === "warn" || k === "warning") return "activity-log-kind--warn";
    if (k === "scan" || k === "download" || k === "remote") return "activity-log-kind--accent";
    if (k === "info") return "activity-log-kind--info";
    return "";
  }

  function onVizChange(next: string) {
    if ((VISUALIZER_MODES as readonly string[]).includes(next)) {
      const mode = next as VisualizerMode;
      vizValue = mode;
      patchUserPrefs({ visualizerMode: mode });
    }
  }

  $effect(() => {
    if (section === "Libreria") void loadHubConfig();
    if (section === "Sistema") {
      void loadDiag();
      void loadActivity();
    }
  });

  $effect(() => {
    if (section !== "Rete") {
      if (remotePollTimer != null) {
        window.clearInterval(remotePollTimer);
        remotePollTimer = null;
      }
      return;
    }
    void loadRemote();
    if (remotePollTimer != null) window.clearInterval(remotePollTimer);
    remotePollTimer = window.setInterval(() => {
      void loadRemote();
    }, 5000);
    return () => {
      if (remotePollTimer != null) {
        window.clearInterval(remotePollTimer);
        remotePollTimer = null;
      }
    };
  });

  async function onCookiesPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    integBusy = true;
    integErr = "";
    integOk = "";
    try {
      hubConfig = await api.uploadYoutubeCookies(file);
      integOk = t("settings.youtubeCookiesSaved");
    } catch (e) {
      integErr = e instanceof Error ? e.message : String(e);
    } finally {
      integBusy = false;
    }
  }

  async function clearCookies() {
    integBusy = true;
    integErr = "";
    integOk = "";
    try {
      hubConfig = await api.clearYoutubeCookies();
      integOk = t("settings.youtubeCookiesCleared");
    } catch (e) {
      integErr = e instanceof Error ? e.message : String(e);
    } finally {
      integBusy = false;
    }
  }

  async function saveDiscogs() {
    integBusy = true;
    integErr = "";
    integOk = "";
    try {
      hubConfig = await api.setDiscogsToken(discogsDraft);
      discogsDraft = "";
      integOk = t("settings.discogsTokenSaved");
    } catch (e) {
      integErr = e instanceof Error ? e.message : String(e);
    } finally {
      integBusy = false;
    }
  }

  async function clearDiscogs() {
    integBusy = true;
    integErr = "";
    integOk = "";
    try {
      hubConfig = await api.clearDiscogsToken();
      integOk = t("settings.discogsTokenCleared");
    } catch (e) {
      integErr = e instanceof Error ? e.message : String(e);
    } finally {
      integBusy = false;
    }
  }

  $effect(() => {
    fadeValue = String(session.crossfadeSec);
  });

  $effect(() => {
    if (section !== "Account") return;
    void loadAccounts();
  });

  async function loadAccounts() {
    try {
      const data = await api.ensureAccountSession();
      accounts = data;
      selectedAccountId = getSelectedAccountId() || data.defaultAccountId;
      await loadAccountLevels(data);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    }
  }

  async function levelForAccountId(accountId: string): Promise<number | null> {
    try {
      await session.ensureCatalogTracks();
      const tracks = session.catalogTracks;
      const libraryTrackCount =
        session.stats?.track_count ?? tracks.length;
      if (accountId === getSelectedAccountId()) {
        const prefs = loadUserPrefs();
        const playlists = session.playlists;
        const playlistTrackCount = playlists.reduce(
          (s, p) => s + (p.track_count ?? 0),
          0,
        );
        return buildAchievementsSnapshot({
          playCounts: prefs.playCounts,
          tracks,
          favoritesCount: session.favorites.length,
          playlistsCount: playlists.length,
          playlistTrackCount,
          libraryTrackCount,
          shuffleBlocks:
            prefs.excludedRelPaths.length + prefs.excludedAlbumIds.length,
          genreForTrack: (tr) => trackGenre(tr),
        }).level.level;
      }
      const [state, favorites, playlists] = await Promise.all([
        api.getUserStateForAccount(accountId),
        api.favoritesForAccount(accountId),
        api.playlistsForAccount(accountId),
      ]);
      const playlistTrackCount = playlists.reduce(
        (s, p) => s + (p.track_count ?? 0),
        0,
      );
      return buildAchievementsSnapshot({
        playCounts: state.playCounts ?? {},
        tracks,
        favoritesCount: favorites.length,
        playlistsCount: playlists.length,
        playlistTrackCount,
        libraryTrackCount,
        shuffleBlocks:
          (state.excludedRelPaths?.length ?? 0) +
          (state.excludedAlbumIds?.length ?? 0),
        genreForTrack: (tr) => trackGenre(tr),
      }).level.level;
    } catch {
      return null;
    }
  }

  async function loadAccountLevels(snap: AccountsResponse) {
    const entries = await Promise.all(
      snap.accounts.map(async (a) => {
        const level = await levelForAccountId(a.id);
        return level != null ? ([a.id, level] as const) : null;
      }),
    );
    const next: Record<string, number> = {};
    for (const e of entries) {
      if (e) next[e[0]] = e[1];
    }
    accountLevels = next;
  }

  async function selectAccount(id: string) {
    if (!id || id === getSelectedAccountId()) return;
    accountBusy = true;
    accountErr = "";
    accountOk = "";
    try {
      selectedAccountId = id;
      await session.switchAccount(id);
      themeValue = loadUserPrefs().theme;
      customThemeValue = loadUserPrefs().customTheme;
      refreshGlassFromPrefs();
      localeValue = i18n.locale;
      fadeValue = String(session.crossfadeSec);
      vizValue = loadUserPrefs().visualizerMode;
      accountOk = t("settings.accountSwitched");
      window.setTimeout(() => (accountOk = ""), 3000);
      if (accounts) void loadAccountLevels(accounts);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
      selectedAccountId = getSelectedAccountId() || "default";
    } finally {
      accountBusy = false;
    }
  }

  async function createAccount() {
    const name = newAccountName.trim();
    if (!name) return;
    accountBusy = true;
    accountErr = "";
    accountOk = "";
    try {
      const next = await api.createAccount(name);
      accounts = next;
      newAccountName = "";
      const created = next.createdAccountId;
      if (created) {
        selectedAccountId = created;
        await session.switchAccount(created);
        themeValue = loadUserPrefs().theme;
        customThemeValue = loadUserPrefs().customTheme;
        refreshGlassFromPrefs();
        localeValue = i18n.locale;
        vizValue = loadUserPrefs().visualizerMode;
      }
      accountOk = t("settings.accountCreated");
      window.setTimeout(() => (accountOk = ""), 3000);
      void loadAccountLevels(next);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    } finally {
      accountBusy = false;
    }
  }

  async function removeAccount(id: string) {
    if (!accounts || id === accounts.defaultAccountId) return;
    const acc = accounts.accounts.find((a) => a.id === id);
    const name = acc?.name || id;
    if (!confirm(t("settings.accountRemoveConfirm", { name }))) return;
    accountBusy = true;
    accountErr = "";
    try {
      const next = await api.deleteAccount(id);
      accounts = next;
      const current = getSelectedAccountId();
      if (current === id) {
        const fallback = next.defaultAccountId || next.accounts[0]?.id || "default";
        selectedAccountId = fallback;
        await session.switchAccount(fallback);
        themeValue = loadUserPrefs().theme;
        localeValue = i18n.locale;
      } else {
        selectedAccountId = current || next.defaultAccountId;
      }
      accountOk = t("settings.accountRemoved");
      window.setTimeout(() => (accountOk = ""), 3000);
      void loadAccountLevels(next);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    } finally {
      accountBusy = false;
    }
  }

  async function exportProfile() {
    if (!selectedAccountId) return;
    accountBusy = true;
    accountErr = "";
    accountOk = "";
    try {
      const name = await api.exportAccountProfile(selectedAccountId);
      accountOk = t("settings.accountExportOk", { name });
      window.setTimeout(() => (accountOk = ""), 5000);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    } finally {
      accountBusy = false;
    }
  }

  function onFadeChange(next: string) {
    fadeValue = next;
    const n = Number(next) as CrossfadeSec;
    if (n === 0 || n === 3 || n === 5) session.setCrossfade(n);
  }

  function onLocaleChange(next: string) {
    i18n.setLocale(next === "en" ? "en" : "it");
    localeValue = i18n.locale;
  }

  function onThemeChange(next: UiTheme) {
    const theme = normalizeTheme(next);
    themeValue = theme;
    patchUserPrefs({ theme });
    applyTheme(theme, customThemeValue, {
      glassSurfaces,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onCustomThemeChange(next: CustomThemeSettings) {
    customThemeValue = next;
    themeValue = "custom";
    patchUserPrefs({ theme: "custom", customTheme: next });
    applyTheme("custom", next, {
      glassSurfaces,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onGlassSurfacesChange(checked: boolean) {
    glassSurfaces = checked;
    patchUserPrefs({ glassSurfaces: checked });
    syncGlassSurfaceDom(undefined, {
      glassSurfaces: checked,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onGlassOpacityChange(raw: number) {
    const v = normalizeGlassOpacity(raw);
    glassOpacityDraft = v;
    if (glassOpacityTimer) clearTimeout(glassOpacityTimer);
    glassOpacityTimer = setTimeout(() => {
      glassOpacityTimer = null;
      patchUserPrefs({ glassOpacity: v });
      syncGlassSurfaceDom(undefined, {
        glassSurfaces,
        glassOpacity: v,
      });
    }, 120);
  }

  function refreshGlassFromPrefs() {
    const p = loadUserPrefs();
    glassSurfaces = p.glassSurfaces;
    glassOpacityDraft = p.glassOpacity;
  }

  async function runLegacyImport(state: Parameters<typeof applyLegacyUserState>[0]) {
    importBusy = true;
    importError = "";
    importReport = null;
    importPhase = "Caricamento catalogo…";
    try {
      const catalog: Track[] = [];
      const pageSize = 5000;
      for (let offset = 0; ; offset += pageSize) {
        const batch = await api.tracks(pageSize, offset);
        catalog.push(...batch);
        if (batch.length < pageSize) break;
      }
      session.catalogTracks = catalog;
      if (!session.allAlbums.length) await session.loadAllAlbums();
      await session.loadFavorites();
      await session.loadPlaylists();

      const report = await applyLegacyUserState(state, {
        catalog,
        albums: session.allAlbums,
        existingFavoriteIds: new Set(session.favoriteIds),
        existingPlaylists: session.playlists.map((p) => ({
          id: p.id,
          name: p.name,
        })),
        onProgress: (p) => {
          importPhase = `${p.phase} ${p.done}/${p.total}`;
        },
      });
      importReport = report;
      themeValue = report.theme;
      customThemeValue = loadUserPrefs().customTheme;
      fadeValue = String(loadUserPrefs().crossfadeSec);
      vizValue = loadUserPrefs().visualizerMode;
      refreshGlassFromPrefs();
      importPhase = "Completato";
      await session.refreshAll();
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
      importPhase = "";
    } finally {
      importBusy = false;
    }
  }

  async function onKordFolderPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const files = input.files;
    input.value = "";
    if (!files?.length) return;
    importBusy = true;
    importError = "";
    importReport = null;
    importSource = "";
    importPhase = "Lettura cartella .kord…";
    try {
      const { state, sourcePath } = await pickUserStateFromKordFolder(files);
      importSource = sourcePath;
      await runLegacyImport(state);
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
      importPhase = "";
      importBusy = false;
    }
  }

  async function runBackupDownload() {
    backupBusy = true;
    backupErr = "";
    backupOk = "";
    try {
      const name = await api.downloadBackup();
      backupOk = t("settings.backupOk", { name });
      window.setTimeout(() => (backupOk = ""), 5000);
    } catch (e) {
      backupErr = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  async function onRestoreZipPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      restoreErr = t("settings.restoreZipErr");
      return;
    }
    restoreBusy = true;
    restoreErr = "";
    restoreOk = "";
    try {
      const data = await api.restoreBackup(file);
      if (data.themeImported) {
        await session.pullUserState({ skipFlush: true });
        refreshGlassFromPrefs();
        customThemeValue = loadUserPrefs().customTheme;
        themeValue = loadUserPrefs().theme;
        restoreOk = t("settings.themeImportSuccess");
        window.setTimeout(() => window.location.reload(), 1200);
        return;
      }
      restoreOk = t("settings.restoreOk", {
        version: data.version ?? "?",
        tracks: data.scanned_tracks ?? 0,
        favorites: data.favorites ?? 0,
        playlists: data.playlists ?? 0,
      });
      await session.refreshAll();
      window.setTimeout(() => (restoreOk = ""), 8000);
    } catch (e) {
      restoreErr = e instanceof Error ? e.message : String(e);
    } finally {
      restoreBusy = false;
    }
  }

  async function onThemeImportPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      themeImportErr = t("settings.themeImportZipErr");
      return;
    }
    themeImportBusy = true;
    themeImportErr = "";
    themeImportOk = "";
    themeExportOk = "";
    themeExportErr = "";
    try {
      const data = await api.restoreBackup(file, { themeOnly: true });
      if (!data.themeImported) {
        themeImportErr = t("settings.themeImportZipErr");
        return;
      }
      // Server is source of truth (theme + glass + customTheme + bg).
      await session.pullUserState({ skipFlush: true });
      refreshGlassFromPrefs();
      customThemeValue = loadUserPrefs().customTheme;
      themeValue = loadUserPrefs().theme;
      themeImportOk = t("settings.themeImportSuccess");
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      themeImportErr = e instanceof Error ? e.message : String(e);
    } finally {
      themeImportBusy = false;
    }
  }

  async function runThemeExport() {
    themeExportBusy = true;
    themeExportErr = "";
    themeExportOk = "";
    themeImportErr = "";
    themeImportOk = "";
    try {
      const name = await api.downloadThemeExport();
      themeExportOk = t("settings.themeExportSuccess", { name });
      window.setTimeout(() => (themeExportOk = ""), 5000);
    } catch (e) {
      themeExportErr = e instanceof Error ? e.message : String(e);
    } finally {
      themeExportBusy = false;
    }
  }
</script>

<div class="view-page settings-page">
  <header class="view-page__toolbar-band">
    <section class="rk-surface-card surface-card--toolbar-only">
      <div class="section-head section-head--page-toolbar">
        <div class="section-head__lead">
          <span class="section-head__icon-wrap" aria-hidden="true">
            <UiIcon name="settings" class="section-head__ic" />
          </span>
          <div class="section-head__text">
            <p class="rk-eyebrow">{t("settings.eyebrow")}</p>
            <SectionNavTabs
              tabs={settingsTabs}
              active={section}
              ariaLabel={t("settings.tabsAria")}
              onselect={(id) => (section = id)}
            />
          </div>
        </div>
      </div>
    </section>
  </header>

  <div class="settings-page__body">
    {#if section === "Account"}
      <Panel title={t("settings.panel.account")}>
        <p class="hint">{t("settings.accountHint")}</p>
        {#if accountErr}
          <p class="hint warn">{accountErr}</p>
        {/if}
        {#if accountOk}
          <p class="hint ok">{accountOk}</p>
        {/if}
        {#if accounts}
          <AccountList>
            {#each accounts.accounts as account (account.id)}
              {@const level = accountLevels[account.id]}
              {@const isDefault = account.id === accounts.defaultAccountId}
              <AccountRow
                name={account.name}
                selected={account.id === selectedAccountId}
                busy={accountBusy}
                level={level ?? null}
                levelTitle={level != null ? titleForNumericLevel(level) : ""}
                levelLabel={level != null
                  ? t("achievements.levelBadge", { n: level })
                  : ""}
                defaultBadge={isDefault && level == null
                  ? t("settings.accountDefaultBadge")
                  : ""}
                removeLabel={t("settings.accountRemove")}
                removeDisabled={isDefault}
                removeTitle={isDefault
                  ? t("settings.accountRemoveDisabledDefault")
                  : undefined}
                onselect={() => void selectAccount(account.id)}
                onremove={() => void removeAccount(account.id)}
              />
            {/each}
          </AccountList>
        {/if}
        <Field label={t("settings.accountNewName")}>
          <TextInput
            bind:value={newAccountName}
            placeholder={t("settings.accountNewPh")}
            disabled={accountBusy}
          />
        </Field>
        <ActionRow>
          <Button disabled={accountBusy || !newAccountName.trim()} onclick={createAccount}>
            {t("settings.accountNew")}
          </Button>
          <Button variant="ghost" disabled={accountBusy || !selectedAccountId} onclick={exportProfile}>
            {t("settings.accountExport")}
          </Button>
        </ActionRow>
      </Panel>
    {:else if section === "Interfaccia"}
      <Panel title={t("settings.panel.ui")} class="settings-ui-section">
        {#snippet actions()}
          <input
            bind:this={themeImportInput}
            class="sr-only"
            type="file"
            accept=".zip,application/zip"
            aria-label={t("settings.themeImportAria")}
            onchange={(e) => void onThemeImportPicked(e)}
          />
          <Button
            variant="ghost"
            disabled={themeImportBusy || themeExportBusy || backupBusy || restoreBusy}
            aria-label={t("settings.themeImportAria")}
            onclick={() => themeImportInput?.click()}
          >
            {themeImportBusy
              ? t("settings.themeImportRunning")
              : t("settings.themeImportCta")}
          </Button>
          <Button
            variant="ghost"
            class="settings-theme-export-btn"
            disabled={themeExportBusy || themeImportBusy || backupBusy || restoreBusy}
            aria-label={t("settings.themeExportAria")}
            title={t("settings.themeExportTitle")}
            onclick={() => void runThemeExport()}
          >
            <UiIcon name="download" class="settings-theme-export-btn__ic" />
          </Button>
        {/snippet}
        {#if themeImportErr}
          <p class="hint warn settings-theme-import-msg" role="alert">{themeImportErr}</p>
        {/if}
        {#if themeImportOk}
          <p class="hint ok settings-theme-import-msg" aria-live="polite">{themeImportOk}</p>
        {/if}
        {#if themeExportErr}
          <p class="hint warn settings-theme-import-msg" role="alert">{themeExportErr}</p>
        {/if}
        {#if themeExportOk}
          <p class="hint ok settings-theme-import-msg" aria-live="polite">{themeExportOk}</p>
        {/if}
        <SettingsFieldsGrid>
          <div class="settings-fields-grid__span settings-language-field">
            <Field label={t("settings.language")}>
              <Select
                options={languageOptions}
                bind:value={localeValue}
                aria-label={t("settings.language")}
                onchange={(ev) => onLocaleChange(selectValue(ev))}
              />
            </Field>
          </div>
          <div class="settings-theme-glass-block settings-fields-grid__span">
            <div
              class="settings-theme-glass-row"
              class:settings-theme-glass-row--custom={themeValue === "custom"}
            >
              <div class="settings-theme-glass-row__theme">
                <Field label={t("settings.theme")}>
                  <ThemePicker
                    value={themeValue}
                    customTheme={customThemeValue}
                    onchange={onThemeChange}
                    onCustomThemeChange={onCustomThemeChange}
                    ariaLabel={t("settings.themeAria")}
                    showCustomizeButton={false}
                    customizeOpen={customThemeDialogOpen}
                    onCustomizeOpenChange={(open) => (customThemeDialogOpen = open)}
                  />
                </Field>
              </div>
              {#if themeValue === "custom"}
                <button
                  type="button"
                  class="theme-picker__customize-btn settings-theme-glass-row__customize"
                  onclick={() => (customThemeDialogOpen = true)}
                >
                  {t("themePicker.customEditBtn")}
                </button>
              {/if}
              <div class="settings-glass-opacity settings-theme-glass-row__opacity">
                <span class="settings-glass-opacity__label">{t("settings.glassOpacity")}</span>
                <input
                  type="range"
                  class="settings-glass-opacity__slider"
                  min={0}
                  max={100}
                  step={1}
                  disabled={!glassSurfaces}
                  value={glassOpacityDraft}
                  oninput={(e) =>
                    onGlassOpacityChange(
                      Number((e.currentTarget as HTMLInputElement).value),
                    )
                  }
                  aria-label={t("settings.glassOpacity")}
                />
                <input
                  type="number"
                  class="settings-glass-opacity__num"
                  min={0}
                  max={100}
                  inputmode="numeric"
                  disabled={!glassSurfaces}
                  value={glassOpacityDraft}
                  oninput={(e) => {
                    const el = e.currentTarget as HTMLInputElement;
                    if (el.value === "") return;
                    onGlassOpacityChange(Number(el.value));
                  }}
                  aria-label={t("settings.glassOpacity")}
                />
                <span class="settings-glass-opacity__unit" aria-hidden="true">%</span>
              </div>
            </div>
            <label class="settings-glass-toggle">
              <input
                type="checkbox"
                class="settings-checkbox"
                checked={glassSurfaces}
                onchange={(e) =>
                  onGlassSurfacesChange(
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <span>{t("settings.glassSurfaces")}</span>
            </label>
          </div>
        </SettingsFieldsGrid>
      </Panel>
      <Panel title={t("settings.panel.player")} class="settings-player-section">
        <SettingsFieldsGrid>
          <Field label={t("settings.visualizer")}>
            <Select
              options={vizOptions}
              bind:value={vizValue}
              aria-label={t("settings.visualizerAria")}
              onchange={(ev) => onVizChange(selectValue(ev))}
            />
          </Field>
          <Field label={t("settings.crossfade")}>
            <Select
              options={fadeOptions}
              bind:value={fadeValue}
              aria-label={t("settings.crossfadeAria")}
              onchange={(ev) => onFadeChange(selectValue(ev))}
            />
          </Field>
        </SettingsFieldsGrid>
        <p class="hint">{t("settings.playerHint")}</p>
      </Panel>
      <Panel title={t("settings.panel.shortcuts")} class="settings-shortcuts-section">
        <ShortcutList items={shortcutItems} />
      </Panel>
    {:else if section === "Libreria"}
      {@const ytActionsOpen =
        !hubConfig?.youtubeCookiesLockedByEnv &&
        hubConfig?.youtubeCookiesWritable !== false}
      {@const discogsActionsOpen = !hubConfig?.discogsLockedByEnv}
      {#snippet youtubeActions()}
        <input
          bind:this={cookiesInput}
          class="sr-only"
          type="file"
          accept=".txt,text/plain"
          onchange={(e) => void onCookiesPicked(e)}
        />
        <Button disabled={integBusy} onclick={() => cookiesInput?.click()}>
          {integBusy ? t("settings.saving") : t("settings.youtubeCookiesChoose")}
        </Button>
        <Button
          variant="ghost"
          disabled={integBusy || !hubConfig?.youtubeCookiesConfigured}
          onclick={() => void clearCookies()}
        >
          {t("settings.youtubeCookiesClear")}
        </Button>
      {/snippet}
      {#snippet discogsActions()}
        <TextInput
          type="password"
          bind:value={discogsDraft}
          placeholder={t("settings.discogsTokenPh")}
          autocomplete="off"
          aria-label={t("settings.discogsTokenAria")}
          disabled={integBusy}
        />
        <div class="integration-row__btn-row">
          <Button
            disabled={integBusy || !discogsDraft.trim()}
            onclick={() => void saveDiscogs()}
          >
            {integBusy ? t("settings.saving") : t("settings.discogsSave")}
          </Button>
          <Button
            variant="ghost"
            disabled={integBusy || !hubConfig?.discogsTokenConfigured}
            onclick={() => void clearDiscogs()}
          >
            {t("settings.discogsClear")}
          </Button>
        </div>
      {/snippet}
      <Panel title={t("settings.panel.library")}>
        <Field label={t("settings.libraryPath")}>
          <TextInput value={session.stats?.music_root ?? "—"} readonly />
        </Field>
        {#if session.stats?.disk_total_bytes != null && session.stats?.disk_available_bytes != null}
          <Field label={t("settings.libraryDisk")}>
            <DiskSpaceMeter
              freeBytes={session.stats.disk_available_bytes}
              totalBytes={session.stats.disk_total_bytes}
              label={t("settings.libraryDisk")}
              valueText={t("settings.libraryDiskValue", {
                free: formatBytes(session.stats.disk_available_bytes),
                total: formatBytes(session.stats.disk_total_bytes),
              })}
            />
          </Field>
        {/if}
        <p class="hint">
          {t("settings.libraryHint", { at: session.stats?.last_scan_at ?? "—" })}
        </p>
        <ActionRow>
          <Button variant="ghost" onclick={() => void session.refreshAll()}
            >{t("settings.libraryReload")}</Button
          >
        </ActionRow>
      </Panel>
      <Panel title={t("settings.panel.integrations")} class="settings-integrations-section">
        <IntegrationList>
          <IntegrationRow
            title={t("settings.youtubeCookiesHeading")}
            statusOn={!!hubConfig?.youtubeCookiesConfigured}
            stretchActions
            actions={ytActionsOpen ? youtubeActions : undefined}
          >
            {#snippet children()}
              <p class="integration-row__lead">
                {t("settings.youtubeCookiesLead")}
              </p>
            {/snippet}
            {#snippet status()}
              {#if hubConfig?.youtubeCookiesConfigured}
                {t("settings.youtubeCookiesActive", {
                  name: hubConfig.youtubeCookiesLabel || "cookies.txt",
                })}
              {:else}
                {t("settings.youtubeCookiesMissing")}
              {/if}
            {/snippet}
            {#snippet aside()}
              {#if hubConfig?.youtubeCookiesLockedByEnv}
                <p class="integration-row__warn">
                  {t("settings.youtubeCookiesEnvLocked")}
                </p>
              {:else if hubConfig?.youtubeCookiesWritable === false}
                <p class="integration-row__lead">
                  {t("settings.integrationsReadOnly")}
                </p>
              {/if}
            {/snippet}
          </IntegrationRow>

          <IntegrationRow
            title={t("settings.discogsHeading")}
            statusOn={!!hubConfig?.discogsTokenConfigured}
            stackedActions
            actions={discogsActionsOpen ? discogsActions : undefined}
          >
            {#snippet children()}
              <p class="integration-row__lead">{t("settings.discogsLead")}</p>
            {/snippet}
            {#snippet status()}
              {#if hubConfig?.discogsTokenConfigured}
                {t("settings.discogsHintWithToken")}
              {:else}
                {t("settings.discogsHintNoToken")}
              {/if}
              {" · "}
              <a
                class="integration-row__link"
                href="https://www.discogs.com/settings/developers"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("settings.discogsDevLink")}
              </a>
            {/snippet}
            {#snippet aside()}
              {#if hubConfig?.discogsLockedByEnv}
                <p class="integration-row__warn">
                  {t("settings.discogsEnvLocked")}
                </p>
              {/if}
            {/snippet}
          </IntegrationRow>
        </IntegrationList>
        {#if integOk}
          <p class="hint import-status">{integOk}</p>
        {/if}
        {#if integErr}
          <p class="import-error" role="alert">{integErr}</p>
        {/if}
        <p class="hint settings-integrations-footnote">
          {t("settings.integrationsFootnote")}
        </p>
      </Panel>
    {:else if section === "Rete"}
      <Panel title={t("settings.panel.server")}>
        <p class="hint">{t("settings.networkHint")}</p>
        <Field label={t("settings.baseUrl")}>
          <TextInput bind:value={session.serverUrl} placeholder="http://127.0.0.1:7420" />
        </Field>
        <ActionRow>
          <Button onclick={() => session.saveServer()}>{t("settings.saveConnect")}</Button>
          <Button variant="ghost" onclick={() => void session.refreshAll()}
            >{t("settings.reload")}</Button
          >
        </ActionRow>
        <p class="hint">
          {t("settings.hubStatus", { status: session.status || "…" })}
        </p>
      </Panel>
      <Panel title={t("settings.panel.remote")}>
        <RemoteAccessPanel
          remote={remoteInfo}
          busy={remoteBusy}
          error={remoteErr}
          copyOk={remoteUrlCopyOk}
          onLogin={() => void remoteLogin()}
          onLogout={() => void remoteLogout()}
          onToggleShare={() => void remoteToggleShare()}
          onCopyUrl={(url) => void copyRemoteUrl(url)}
        />
      </Panel>
    {:else}
      <Panel title={t("settings.panel.backup")}>
        <p class="hint">{t("settings.backupHint")}</p>
        <ActionRow>
          <Button
            disabled={backupBusy || restoreBusy || importBusy}
            onclick={() => void runBackupDownload()}
          >
            {backupBusy ? t("settings.backupPreparing") : t("settings.backupDownload")}
          </Button>
          <Button
            variant="ghost"
            disabled={backupBusy || restoreBusy || importBusy}
            onclick={() => restoreFileInput?.click()}
          >
            {restoreBusy ? t("settings.backupRestoring") : t("settings.backupRestore")}
          </Button>
        </ActionRow>
        <input
          bind:this={restoreFileInput}
          class="sr-only"
          type="file"
          accept=".zip,application/zip"
          onchange={(e) => void onRestoreZipPicked(e)}
        />
        {#if backupErr}
          <p class="import-error" role="alert">{backupErr}</p>
        {/if}
        {#if backupOk}
          <p class="hint import-status">{backupOk}</p>
        {/if}
        {#if restoreErr}
          <p class="import-error" role="alert">{restoreErr}</p>
        {/if}
        {#if restoreOk}
          <p class="hint import-status">{restoreOk}</p>
        {/if}
        <input
          bind:this={kordDirInput}
          class="sr-only"
          type="file"
          multiple
          onchange={(e) => void onKordFolderPicked(e)}
        />
        <button
          type="button"
          class="legacy-import-link"
          disabled={importBusy || backupBusy || restoreBusy}
          onclick={() => {
            if (!kordDirInput) return;
            kordDirInput.setAttribute("webkitdirectory", "");
            kordDirInput.setAttribute("directory", "");
            kordDirInput.click();
          }}
        >
          {t("settings.legacyImport")}
        </button>
        {#if importBusy || importPhase}
          <p class="hint import-status" aria-live="polite">
            {importBusy ? t("settings.importRunning", { phase: importPhase }) : importPhase}
            {#if importSource}
              <span class="import-source"> · {importSource}</span>
            {/if}
          </p>
        {/if}
        {#if importError}
          <p class="import-error" role="alert">{importError}</p>
        {/if}
        {#if importReport}
          <ul class="import-report">
            <li>
              Preferiti: {importReport.favoritesOk} ok · {importReport.favoritesSkip} saltati
            </li>
            <li>
              Playlist: {importReport.playlistOk} · brani {importReport.playlistTracksOk} /
              {importReport.playlistTracksSkip} saltati
            </li>
            <li>
              Play count: {importReport.playCounts} · recenti: {importReport.recent} · mood:
              {importReport.moods}
            </li>
            <li>
              Esclusioni: {importReport.excludedTracks} tracce · {importReport.excludedAlbums} album
              · tema: {importReport.theme}
            </li>
            {#if importReport.warnings.length}
              <li class="import-report__warn">
                Avvisi ({importReport.warnings.length}): {importReport.warnings
                  .slice(0, 3)
                  .join(" · ")}{importReport.warnings.length > 3 ? "…" : ""}
              </li>
            {/if}
          </ul>
        {/if}
      </Panel>
      {#snippet activityActions()}
        <Button
          variant="ghost"
          disabled={activityBusy}
          onclick={() => void loadActivity()}
        >
          {activityBusy
            ? t("settings.activityLogReloading")
            : t("settings.activityLogReload")}
        </Button>
      {/snippet}
      <Panel
        title={t("settings.panel.activity")}
        class="settings-activity-section"
        actions={activityActions}
      >
        {#if activityErr}
          <p class="hint warn">{activityErr}</p>
        {:else if activityLoaded && activityEntries.length === 0}
          <p class="hint">{t("settings.activityLogEmpty")}</p>
        {/if}
        {#if activityEntries.length > 0}
          <div class="activity-log-scroll" role="region" aria-label={t("settings.panel.activity")}>
            <table class="activity-log-table">
              <thead>
                <tr>
                  <th scope="col">{t("settings.activityLogColTime")}</th>
                  <th scope="col">{t("settings.activityLogColKind")}</th>
                  <th scope="col">{t("settings.activityLogColDetail")}</th>
                </tr>
              </thead>
              <tbody>
                {#each activityEntries as e, i (`${e.ts}-${e.kind}-${i}`)}
                  <tr>
                    <td class="activity-log-td-time">{formatActivityTs(e.ts)}</td>
                    <td>
                      <span class="activity-log-kind {activityKindClass(e.kind)}">{e.kind}</span>
                    </td>
                    <td class="activity-log-td-msg" title={e.message}>{e.message || "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
      <Panel title={t("settings.panel.diagnostics")}>
        <p class="hint">
          {t("settings.diagHint", {
            version: diag?.version ?? APP_VERSION,
            tracks: diag?.db.trackCount ?? session.stats?.track_count ?? "—",
            albums: diag?.db.albumCount ?? session.stats?.album_count ?? "—",
          })}
        </p>
        {#if diag}
          <p class="hint">
            Uptime {diag.uptimeSecs}s · scanning {diag.scanning ? "sì" : "no"} · download attivi
            {diag.activeDownloads}
          </p>
        {/if}
        <ActionRow>
          <Button
            variant="ghost"
            onclick={() =>
              void (async () => {
                await session.refreshAll();
                await loadDiag();
              })()}>{t("settings.healthCheck")}</Button
          >
          <Button
            variant="ghost"
            onclick={() => {
              const report = JSON.stringify(
                { app: APP_VERSION, diag, stats: session.stats, remote: remoteInfo },
                null,
                2,
              );
              void navigator.clipboard.writeText(report);
            }}>{t("settings.copyReport")}</Button
          >
        </ActionRow>
      </Panel>
    {/if}
  </div>
</div>

<style>
  .hint {
    margin: 0 0 0.85rem;
    color: var(--rk-muted);
  }

  .hint.warn {
    color: var(--rk-danger, #e85d5d);
  }

  .hint.ok {
    color: var(--rk-accent-2, #6bcf8e);
  }

  .hint :global(code) {
    font-family: var(--rk-mono);
    font-size: 0.78em;
    color: var(--rk-muted-strong);
  }

  .import-error {
    margin: 0.65rem 0 0;
    color: var(--rk-danger, #e85d5d);
    font-size: 0.88rem;
  }

  .import-report {
    list-style: none;
    margin: 0.85rem 0 0;
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.35rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    background: color-mix(in srgb, var(--rk-surface-3) 70%, transparent);
    font-size: 0.84rem;
    color: var(--rk-muted-strong);
  }

  .import-report__warn {
    color: color-mix(in srgb, var(--rk-accent) 70%, var(--rk-muted) 30%);
  }

  .import-status {
    margin-top: 0.65rem;
  }

  .import-source {
    opacity: 0.75;
    font-size: 0.78em;
    word-break: break-all;
  }

  .legacy-import-link {
    display: inline-block;
    margin-top: 0.85rem;
    padding: 0;
    border: none;
    background: none;
    color: color-mix(in srgb, var(--rk-muted) 85%, transparent);
    font: inherit;
    font-size: 0.78rem;
    letter-spacing: 0.02em;
    text-decoration: underline;
    text-underline-offset: 0.18em;
    cursor: pointer;
    opacity: 0.72;
  }

  .legacy-import-link:hover:not(:disabled) {
    opacity: 1;
    color: var(--rk-muted-strong);
  }

  .legacy-import-link:disabled {
    cursor: wait;
    opacity: 0.45;
  }
</style>
