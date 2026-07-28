<script lang="ts">
  import {
    ActionRow,
    Button,
    Field,
    Panel,
    Select,
    TextInput,
  } from "@rekord/ui";
  import SectionNavTabs from "../components/SectionNavTabs.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import {
    getSelectedAccountId,
    type AccountsResponse,
  } from "../lib/account";
  import { session } from "../lib/session.svelte";
  import { api, type HubConfig, type Track } from "../lib/api";
  import {
    applyLegacyUserState,
    pickUserStateFromKordFolder,
    type LegacyImportReport,
  } from "../lib/legacyImport";
  import { i18n, t } from "../lib/i18n.svelte";
  import {
    UI_THEMES,
    applyTheme,
    loadUserPrefs,
    normalizeTheme,
    patchUserPrefs,
    type CrossfadeSec,
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

  const themeOptions = $derived(
    UI_THEMES.map((id) => ({
      value: id,
      label:
        id === "midnight"
          ? `${t(`theme.${id}`)} (${t("settings.themeDefault")})`
          : t(`theme.${id}`),
    })),
  );

  const glassOptions = $derived([
    { value: "off", label: t("settings.glassOff") },
    { value: "soft", label: t("settings.glassSoftSoon") },
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
  let section = $state("Interfaccia");

  let accounts = $state<AccountsResponse | null>(null);
  let selectedAccountId = $state(getSelectedAccountId() || "default");
  let newAccountName = $state("");
  let renameDraft = $state("");
  let accountBusy = $state(false);
  let accountErr = $state("");
  let accountOk = $state("");

  const accountOptions = $derived(
    (accounts?.accounts || []).map((a) => ({
      value: a.id,
      label:
        a.id === accounts?.defaultAccountId
          ? `${a.name} (${t("settings.accountDefaultBadge")})`
          : a.name,
    })),
  );

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

  let hubConfig = $state<HubConfig | null>(null);
  let integBusy = $state(false);
  let integErr = $state("");
  let integOk = $state("");
  let discogsDraft = $state("");
  let cookiesInput: HTMLInputElement | undefined = $state();

  async function loadHubConfig() {
    try {
      hubConfig = await api.config();
    } catch {
      hubConfig = null;
    }
  }

  $effect(() => {
    if (section === "Libreria") void loadHubConfig();
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
      integOk = "Cookie YouTube caricati.";
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
      integOk = "Cookie YouTube rimossi.";
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
      integOk = "Token Discogs salvato.";
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
      integOk = "Token Discogs rimosso.";
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
      const cur = data.accounts.find((a) => a.id === selectedAccountId);
      renameDraft = cur?.name || "";
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    }
  }

  async function onActiveAccountChange() {
    if (!selectedAccountId || selectedAccountId === getSelectedAccountId()) return;
    accountBusy = true;
    accountErr = "";
    accountOk = "";
    try {
      await session.switchAccount(selectedAccountId);
      themeValue = loadUserPrefs().theme;
      localeValue = i18n.locale;
      fadeValue = String(session.crossfadeSec);
      const cur = accounts?.accounts.find((a) => a.id === selectedAccountId);
      renameDraft = cur?.name || "";
      accountOk = t("settings.accountSwitched");
      window.setTimeout(() => (accountOk = ""), 3000);
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
        localeValue = i18n.locale;
      }
      accountOk = t("settings.accountCreated");
      window.setTimeout(() => (accountOk = ""), 3000);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    } finally {
      accountBusy = false;
    }
  }

  async function renameAccount() {
    const name = renameDraft.trim();
    if (!name || !selectedAccountId) return;
    accountBusy = true;
    accountErr = "";
    try {
      accounts = await api.renameAccount(selectedAccountId, name);
      accountOk = t("settings.accountRenamed");
      window.setTimeout(() => (accountOk = ""), 3000);
    } catch (e) {
      accountErr = e instanceof Error ? e.message : String(e);
    } finally {
      accountBusy = false;
    }
  }

  async function removeAccount() {
    if (!accounts || selectedAccountId === accounts.defaultAccountId) return;
    const acc = accounts.accounts.find((a) => a.id === selectedAccountId);
    const name = acc?.name || selectedAccountId;
    if (!confirm(t("settings.accountRemoveConfirm", { name }))) return;
    accountBusy = true;
    accountErr = "";
    try {
      const next = await api.deleteAccount(selectedAccountId);
      accounts = next;
      const fallback = next.defaultAccountId || next.accounts[0]?.id || "default";
      selectedAccountId = fallback;
      await session.switchAccount(fallback);
      themeValue = loadUserPrefs().theme;
      localeValue = i18n.locale;
      accountOk = t("settings.accountRemoved");
      window.setTimeout(() => (accountOk = ""), 3000);
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

  function onFadeChange() {
    const n = Number(fadeValue) as CrossfadeSec;
    if (n === 0 || n === 3 || n === 5) session.setCrossfade(n);
  }

  function onLocaleChange() {
    i18n.setLocale(localeValue === "en" ? "en" : "it");
    localeValue = i18n.locale;
  }

  function onThemeChange() {
    const next = normalizeTheme(themeValue);
    themeValue = next;
    patchUserPrefs({ theme: next });
    applyTheme(next);
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
      fadeValue = String(loadUserPrefs().crossfadeSec);
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
        <Field label={t("settings.accountActive")}>
          <Select
            options={accountOptions.length
              ? accountOptions
              : [{ value: "default", label: t("settings.accountLocal") }]}
            bind:value={selectedAccountId}
            onchange={onActiveAccountChange}
            disabled={accountBusy || !accountOptions.length}
            aria-label={t("settings.accountActive")}
          />
        </Field>
        <Field label={t("settings.accountRename")}>
          <TextInput
            bind:value={renameDraft}
            placeholder={t("settings.accountRenamePh")}
            disabled={accountBusy}
          />
        </Field>
        <ActionRow>
          <Button disabled={accountBusy || !renameDraft.trim()} onclick={renameAccount}>
            {t("settings.accountRenameCta")}
          </Button>
          <Button
            variant="ghost"
            disabled={accountBusy ||
              !accounts ||
              selectedAccountId === accounts.defaultAccountId}
            onclick={removeAccount}
          >
            {t("settings.accountRemove")}
          </Button>
        </ActionRow>
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
      <Panel title={t("settings.panel.ui")}>
        <Field label={t("settings.language")}>
          <Select
            options={languageOptions}
            bind:value={localeValue}
            onchange={onLocaleChange}
            aria-label={t("settings.language")}
          />
        </Field>
        <Field label={t("settings.theme")}>
          <Select
            options={themeOptions}
            bind:value={themeValue}
            onchange={onThemeChange}
            aria-label={t("settings.themeAria")}
          />
        </Field>
        <Field label={t("settings.glass")}>
          <Select options={glassOptions} value="off" disabled />
        </Field>
      </Panel>
      <Panel title={t("settings.panel.player")}>
        <Field label={t("settings.crossfade")}>
          <Select
            options={fadeOptions}
            bind:value={fadeValue}
            onchange={onFadeChange}
            aria-label={t("settings.crossfadeAria")}
          />
        </Field>
        <p class="hint">{t("settings.playerHint")}</p>
      </Panel>
      <Panel title={t("settings.panel.shortcuts")}>
        <ul class="keys">
          <li><kbd>Ctrl</kbd>+<kbd>K</kbd> {t("settings.shortcut.search")}</li>
          <li><kbd>Space</kbd> {t("settings.shortcut.playPause")}</li>
          <li><kbd>←</kbd> / <kbd>→</kbd> {t("settings.shortcut.prevNext")}</li>
          <li><kbd>S</kbd> {t("settings.shortcut.shuffle")}</li>
        </ul>
      </Panel>
    {:else if section === "Libreria"}
      <Panel title={t("settings.panel.library")}>
        <Field label={t("settings.libraryPath")}>
          <TextInput value={session.stats?.music_root ?? "—"} readonly />
        </Field>
        <p class="hint">
          {t("settings.libraryHint", { at: session.stats?.last_scan_at ?? "—" })}
        </p>
        <ActionRow>
          <Button variant="ghost" onclick={() => void session.refreshAll()}
            >{t("settings.libraryReload")}</Button
          >
        </ActionRow>
      </Panel>
      <Panel title={t("settings.panel.integrations")}>
        <Field label={t("settings.youtubeCookies")}>
          <TextInput
            value={hubConfig?.youtubeCookiesConfigured
              ? hubConfig.youtubeCookiesLabel || "cookies.txt"
              : "Non configurati"}
            readonly
          />
        </Field>
        {#if hubConfig?.youtubeCookiesLockedByEnv}
          <p class="hint">Bloccati da variabile d’ambiente (REKORD_YTDLP_COOKIES).</p>
        {:else}
          <ActionRow>
            <Button
              disabled={integBusy || hubConfig?.youtubeCookiesWritable === false}
              onclick={() => cookiesInput?.click()}
            >
              {integBusy ? "…" : "Carica cookies.txt"}
            </Button>
            <Button
              variant="ghost"
              disabled={integBusy || !hubConfig?.youtubeCookiesConfigured}
              onclick={() => void clearCookies()}
            >
              Rimuovi
            </Button>
          </ActionRow>
          <input
            bind:this={cookiesInput}
            class="sr-only"
            type="file"
            accept=".txt,text/plain"
            onchange={(e) => void onCookiesPicked(e)}
          />
        {/if}

        <Field label={t("settings.discogsToken")}>
          <TextInput
            bind:value={discogsDraft}
            placeholder={hubConfig?.discogsTokenConfigured
              ? "Token configurato — inserisci per sostituire"
              : "Token Discogs (opzionale)"}
            disabled={integBusy || hubConfig?.discogsLockedByEnv}
          />
        </Field>
        {#if hubConfig?.discogsLockedByEnv}
          <p class="hint">Bloccato da variabile d’ambiente (REKORD_DISCOGS_TOKEN).</p>
        {:else}
          <ActionRow>
            <Button
              disabled={integBusy || !discogsDraft.trim()}
              onclick={() => void saveDiscogs()}
            >
              Salva token
            </Button>
            <Button
              variant="ghost"
              disabled={integBusy || !hubConfig?.discogsTokenConfigured}
              onclick={() => void clearDiscogs()}
            >
              Rimuovi
            </Button>
          </ActionRow>
        {/if}
        {#if integOk}
          <p class="hint import-status">{integOk}</p>
        {/if}
        {#if integErr}
          <p class="import-error" role="alert">{integErr}</p>
        {/if}
        <p class="hint">
          Cookie Netscape per yt-dlp e token Discogs sono salvati in data_dir del server.
          yt-dlp deve essere installato sul PATH (o YTDLP_PATH).
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
        <p class="hint">{t("settings.remoteHint")}</p>
        <ActionRow>
          <Button disabled>{t("settings.remoteStart")}</Button>
          <Button variant="ghost" disabled>{t("settings.remoteQr")}</Button>
        </ActionRow>
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
      <Panel title={t("settings.panel.activity")}>
        <p class="hint">{t("settings.activityStub")}</p>
        <ul class="log">
          <li><span>info</span> Hub online · {session.status || "—"}</li>
          <li><span>scan</span> Ultimo scan · {session.stats?.last_scan_at ?? "—"}</li>
        </ul>
      </Panel>
      <Panel title={t("settings.panel.diagnostics")}>
        <p class="hint">
          {t("settings.diagHint", {
            version: APP_VERSION,
            tracks: session.stats?.track_count ?? "—",
            albums: session.stats?.album_count ?? "—",
          })}
        </p>
        <ActionRow>
          <Button variant="ghost" onclick={() => void session.refreshAll()}
            >{t("settings.healthCheck")}</Button
          >
          <Button variant="ghost" disabled>{t("settings.copyReport")}</Button>
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

  .keys,
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.55rem;
  }

  .keys {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .keys li,
  .log li {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
    color: var(--rk-muted-strong);
    font-size: 0.88rem;
  }

  @media (max-width: 720px) {
    .keys {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  kbd {
    font-family: var(--rk-mono);
    font-size: 0.72rem;
    border: 1px solid var(--rk-line);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    background: var(--rk-surface);
  }

  .log span {
    font-family: var(--rk-mono);
    font-size: 0.68rem;
    text-transform: uppercase;
    color: var(--rk-accent-2);
    min-width: 3.2rem;
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
