<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ActionRow, Button, Panel, Select, TextInput } from "@rekord/ui";
  import { api, type Track } from "../../lib/api";
  import { hubActivityMsg, hubKind } from "../../lib/hubText";
  import { fmtDate, t } from "../../lib/i18n.svelte";
  import {
    applyLegacyUserState,
    listKordFolderAccounts,
    readKordAccountState,
    type KordAccountCandidate,
  } from "../../lib/legacyImport";
  import { session } from "../../lib/session.svelte";
  import { jsRuntimeLabel, jsRuntimeMissing, pickJsRuntime } from "../../lib/studio/jsRuntime";
  import { APP_VERSION } from "../../lib/version";
  import type { SettingsAccounts } from "./settingsAccounts.svelte";

  let { ctx }: { ctx: SettingsAccounts } = $props();

  const jobs = $derived(ctx.jobs);
  const canManageMachine = $derived(ctx.canManageMachine);

  let kordDirInput: HTMLInputElement | undefined = $state();
  /** Legacy accounts found in the picked `.kord` folder, waiting for a choice. */
  let kordCandidates = $state<KordAccountCandidate[]>([]);
  let kordChoice = $state("");
  let restoreFileInput: HTMLInputElement | undefined = $state();

  let diag = $state<Awaited<ReturnType<typeof api.diagnostics>> | null>(null);
  let ytdlpBusy = $state(false);
  let ytdlpMsg = $state("");
  let ytdlpErr = $state("");
  const ytdlp = $derived(diag?.binaries?.ytdlp ?? null);
  const jsRuntime = $derived(pickJsRuntime(diag?.binaries?.jsRuntime));

  async function updateYtdlp() {
    if (!canManageMachine) return;
    ytdlpBusy = true;
    ytdlpMsg = "";
    ytdlpErr = "";
    try {
      const res = await api.updateYtdlp();
      ytdlpMsg = res.updated
        ? t("core.settings.ytdlpUpdated", { version: res.version ?? res.latestVersion ?? "?" })
        : t("core.settings.ytdlpUpToDate", { version: res.version ?? res.latestVersion ?? "?" });
      await loadDiag();
    } catch (e) {
      ytdlpErr = e instanceof Error ? e.message : String(e);
    } finally {
      ytdlpBusy = false;
    }
  }
  let activityEntries = $state<
    Array<{
      ts: string;
      kind: string;
      message: string;
      code?: string | null;
      params?: Record<string, unknown> | null;
      accountId?: string | null;
      accountName?: string | null;
    }>
  >([]);
  let activityBusy = $state(false);
  let activityErr = $state("");
  let activityLoaded = $state(false);
  /** Local calendar day `YYYY-MM-DD` — used only when session account is Default. */
  let activityDay = $state(todayLocalYmd());
  /** `all` | `system` | `user` | specific account id */
  let activitySource = $state("all");

  const activitySourceOptions = $derived([
    { value: "all", label: t("settings.activityLogSourceAll") },
    { value: "system", label: t("settings.activityLogSourceSystem") },
    { value: "user", label: t("settings.activityLogSourceUsers") },
    ...(ctx.accounts?.accounts ?? []).map((a) => ({
      value: a.id,
      label: a.name || a.id,
    })),
  ]);

  type ActivityQuery = { day?: string; scope?: string; filterAccountId?: string };

  /**
   * The request the filters describe. Kept as a string so the loader effect
   * reruns only when the query really changes — not when the account list
   * arrives and recomputes an identical one.
   */
  const activityQueryKey = $derived.by(() => {
    const opts: ActivityQuery = {};
    // Day + source filters are Default-only; other accounts get last 24h / scope=all.
    if (ctx.isDefaultSessionAccount) {
      if (activityDay.trim()) opts.day = activityDay.trim();
      const src = activitySource.trim();
      if (src === "system") opts.scope = "system";
      else if (src === "user") opts.scope = "user";
      else if (src && src !== "all") opts.filterAccountId = src;
    }
    return JSON.stringify(opts);
  });

  function todayLocalYmd(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async function loadDiag() {
    try {
      diag = await api.diagnostics();
    } catch {
      diag = null;
    }
  }

  async function loadActivity(query: ActivityQuery) {
    activityBusy = true;
    activityErr = "";
    try {
      const res = await api.activityLog(query);
      activityEntries = res.entries || [];
    } catch (e) {
      activityEntries = [];
      activityErr = e instanceof Error ? e.message : String(e);
    } finally {
      activityLoaded = true;
      activityBusy = false;
    }
  }

  onMount(() => {
    void loadDiag();
    if (!ctx.accounts) void ctx.load();
  });

  $effect(() => {
    const query = JSON.parse(activityQueryKey) as ActivityQuery;
    untrack(() => void loadActivity(query));
  });

  function formatActivityTs(ts: string): string {
    return fmtDate(ts, "datetime");
  }

  function activityAccountLabel(e: {
    accountId?: string | null;
    accountName?: string | null;
  }): string {
    const id = (e.accountId || "").trim();
    if (!id) return t("settings.activityLogSystem");
    const named = (e.accountName || "").trim();
    if (named) return named;
    const fromList = ctx.accounts?.accounts.find((a) => a.id === id)?.name;
    return (fromList || "").trim() || id;
  }

  function activityKindClass(kind: string): string {
    const k = kind.trim().toLowerCase();
    if (k === "error" || k === "err" || k === "fail") return "activity-log-kind--err";
    if (k === "warn" || k === "warning") return "activity-log-kind--warn";
    if (k === "scan" || k === "download" || k === "remote") return "activity-log-kind--accent";
    if (k === "info") return "activity-log-kind--info";
    return "";
  }

  async function runLegacyImport(state: Parameters<typeof applyLegacyUserState>[0]) {
    const j = jobs;
    j.importBusy = true;
    j.importError = "";
    j.importReport = null;
    j.importPhase = t("ui.settings.importLoadingCatalog");
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

      const known = session.syncedSetting<Record<string, string>>("legacyPlaylistIds");
      const mapped: Record<string, string> = { ...(known && typeof known === "object" ? known : {}) };
      const report = await applyLegacyUserState(state, {
        catalog,
        albums: session.allAlbums,
        existingFavoriteIds: new Set(session.favoriteIds),
        existingPlaylists: session.playlists.map((p) => ({
          id: p.id,
          name: p.name,
        })),
        legacyPlaylistIds: mapped,
        onPlaylistMapped: (legacyId, hubId) => {
          mapped[legacyId] = hubId;
          session.setSyncedSetting("legacyPlaylistIds", { ...mapped });
        },
        onProgress: (p) => {
          j.importPhase = `${p.phase} ${p.done}/${p.total}`;
        },
      });
      j.importReport = report;
      j.importPhase = t("ui.settings.importDone");
      await session.refreshAll();
    } catch (e) {
      j.importError = e instanceof Error ? e.message : String(e);
      j.importPhase = "";
    } finally {
      j.importBusy = false;
    }
  }

  async function onKordFolderPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    // Copy first: the FileList is live and clearing the input empties it.
    const files = input.files ? [...input.files] : [];
    input.value = "";
    if (!files.length) return;
    const j = jobs;
    j.importError = "";
    j.importReport = null;
    j.importSource = "";
    j.importPhase = t("ui.settings.importReadingFolder");
    try {
      const found = await listKordFolderAccounts(files);
      j.importPhase = "";
      if (found.length === 1) {
        await importKordAccount(found[0]!);
        return;
      }
      // Several legacy accounts: the user picks which one goes into this
      // account (preselect the same name, else the legacy default).
      const current = ctx.accounts?.accounts.find((a) => a.id === session.activeAccountId)?.name;
      const sameName = found.find(
        (c) => current && c.name.trim().toLowerCase() === current.trim().toLowerCase(),
      );
      kordChoice = (sameName ?? found.find((c) => c.isDefault) ?? found[0]!).id;
      kordCandidates = found;
    } catch (e) {
      j.importError = e instanceof Error ? e.message : String(e);
      j.importPhase = "";
    }
  }

  async function importKordAccount(candidate: KordAccountCandidate) {
    const j = jobs;
    kordCandidates = [];
    j.importBusy = true;
    j.importError = "";
    j.importPhase = t("ui.settings.importReadingFolder");
    try {
      const { state, sourcePath } = await readKordAccountState(candidate);
      j.importSource = `${candidate.name} · ${sourcePath}`;
      await runLegacyImport(state);
    } catch (e) {
      j.importError = e instanceof Error ? e.message : String(e);
      j.importPhase = "";
      j.importBusy = false;
    }
  }

  async function runBackupDownload() {
    const j = jobs;
    j.backupBusy = true;
    j.backupErr = "";
    j.backupOk = "";
    try {
      const name = await api.downloadBackup();
      j.backupOk = t("settings.backupOk", { name });
      window.setTimeout(() => (j.backupOk = ""), 5000);
    } catch (e) {
      j.backupErr = e instanceof Error ? e.message : String(e);
    } finally {
      j.backupBusy = false;
    }
  }

  async function onRestoreZipPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !canManageMachine) return;
    const j = jobs;
    if (!/\.zip$/i.test(file.name)) {
      j.restoreErr = t("settings.restoreZipErr");
      return;
    }
    j.restoreBusy = true;
    j.restoreErr = "";
    j.restoreOk = "";
    try {
      const data = await api.restoreBackup(file);
      if (data.themeImported) {
        await session.pullUserState({ skipFlush: true });
        j.restoreOk = t("settings.themeImportSuccess");
        window.setTimeout(() => window.location.reload(), 1200);
        return;
      }
      j.restoreOk = t("settings.restoreOk", {
        version: data.version ?? "?",
        tracks: data.scanned_tracks ?? 0,
        favorites: data.favorites ?? 0,
        playlists: data.playlists ?? 0,
      });
      await session.refreshAll();
      window.setTimeout(() => (j.restoreOk = ""), 8000);
    } catch (e) {
      j.restoreErr = e instanceof Error ? e.message : String(e);
    } finally {
      j.restoreBusy = false;
    }
  }
</script>

<Panel title={t("settings.panel.backup")}>
  <p class="hint">{t("settings.backupHint")}</p>
  <ActionRow>
    <Button
      disabled={jobs.backupBusy || jobs.restoreBusy || jobs.importBusy}
      onclick={() => void runBackupDownload()}
    >
      {jobs.backupBusy ? t("settings.backupPreparing") : t("settings.backupDownload")}
    </Button>
    <Button
      variant="ghost"
      disabled={jobs.backupBusy || jobs.restoreBusy || jobs.importBusy || !canManageMachine}
      onclick={() => restoreFileInput?.click()}
    >
      {jobs.restoreBusy ? t("settings.backupRestoring") : t("settings.backupRestore")}
    </Button>
  </ActionRow>
  {#if !canManageMachine}
    <p class="hint">
      {t("settings.machineOpsHubOnly")}
      {" "}
      <a
        class="rk-link"
        href={session.hubPanelUrl}
        target="_blank"
        rel="noopener noreferrer">{t("settings.openHubPanel")}</a
      >
    </p>
  {/if}
  <input
    bind:this={restoreFileInput}
    class="sr-only"
    type="file"
    accept=".zip,application/zip"
    onchange={(e) => void onRestoreZipPicked(e)}
  />
  {#if jobs.backupErr}
    <p class="import-error" role="alert">{jobs.backupErr}</p>
  {/if}
  {#if jobs.backupOk}
    <p class="hint import-status">{jobs.backupOk}</p>
  {/if}
  {#if jobs.restoreErr}
    <p class="import-error" role="alert">{jobs.restoreErr}</p>
  {/if}
  {#if jobs.restoreOk}
    <p class="hint import-status">{jobs.restoreOk}</p>
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
    class="rk-link rk-link--quiet legacy-import-link"
    disabled={jobs.importBusy || jobs.backupBusy || jobs.restoreBusy}
    onclick={() => {
      if (!kordDirInput) return;
      kordDirInput.setAttribute("webkitdirectory", "");
      kordDirInput.setAttribute("directory", "");
      kordDirInput.click();
    }}
  >
    {t("settings.legacyImport")}
  </button>
  {#if kordCandidates.length > 1}
    {@const target =
      ctx.accounts?.accounts.find((a) => a.id === session.activeAccountId)?.name ?? ""}
    <fieldset class="kord-choice">
      <legend>{t("core.import.chooseAccount", { account: target })}</legend>
      {#each kordCandidates as c (c.id)}
        <label class="kord-choice__row">
          <input type="radio" name="kord-account" value={c.id} bind:group={kordChoice} />
          <span class="kord-choice__name">{c.name}</span>
          {#if c.isDefault}
            <span class="kord-choice__badge">{t("settings.accountDefaultBadge")}</span>
          {/if}
          <span class="kord-choice__size">{Math.max(1, Math.round(c.size / 1024))} KB</span>
        </label>
      {/each}
      <ActionRow>
        <Button
          disabled={!kordChoice}
          onclick={() => {
            const c = kordCandidates.find((x) => x.id === kordChoice);
            if (c) void importKordAccount(c);
          }}>{t("core.import.chooseConfirm")}</Button
        >
        <Button variant="ghost" onclick={() => (kordCandidates = [])}>
          {t("core.import.chooseCancel")}
        </Button>
      </ActionRow>
    </fieldset>
  {/if}
  {#if jobs.importBusy || jobs.importPhase}
    <p class="hint import-status" aria-live="polite">
      {jobs.importBusy
        ? t("settings.importRunning", { phase: jobs.importPhase })
        : jobs.importPhase}
      {#if jobs.importSource}
        <span class="import-source"> · {jobs.importSource}</span>
      {/if}
    </p>
  {/if}
  {#if jobs.importError}
    <p class="import-error" role="alert">{jobs.importError}</p>
  {/if}
  {#if jobs.importReport}
    {@const r = jobs.importReport}
    <ul class="import-report">
      <li>{t("ui.settings.importFavorites", { ok: r.favoritesOk, skip: r.favoritesSkip })}</li>
      <li>
        {t("ui.settings.importPlaylists", {
          ok: r.playlistOk,
          tracks: r.playlistTracksOk,
          skip: r.playlistTracksSkip,
        })}
      </li>
      <li>
        {t("ui.settings.importCounts", {
          plays: r.playCounts,
          recent: r.recent,
          moods: r.moods,
        })}
      </li>
      {#if r.plectrBests}
        <li>{t("core.import.plectrBests", { n: r.plectrBests })}</li>
      {/if}
      <li>
        {t("ui.settings.importExclusions", {
          tracks: r.excludedTracks,
          albums: r.excludedAlbums,
          theme: r.theme,
        })}
      </li>
      {#if r.warnings.length}
        <li class="import-report__warn">
          {t("ui.settings.importWarnings", {
            n: r.warnings.length,
            list: r.warnings.slice(0, 3).join(" · ") + (r.warnings.length > 3 ? "…" : ""),
          })}
        </li>
      {/if}
    </ul>
  {/if}
</Panel>
{#snippet activityActions()}
  <Button
    variant="ghost"
    disabled={activityBusy}
    onclick={() => void loadActivity(JSON.parse(activityQueryKey) as ActivityQuery)}
  >
    {activityBusy ? t("settings.activityLogReloading") : t("settings.activityLogReload")}
  </Button>
{/snippet}
<Panel
  title={t("settings.panel.activity")}
  class="settings-activity-section"
  actions={activityActions}
>
  {#if ctx.isDefaultSessionAccount}
    <div class="activity-log-filters" role="group" aria-label={t("settings.panel.activity")}>
      <label class="activity-log-filter">
        <span class="activity-log-filter__label">{t("settings.activityLogDay")}</span>
        <TextInput
          type="date"
          bind:value={activityDay}
          aria-label={t("settings.activityLogDay")}
        />
      </label>
      <label class="activity-log-filter activity-log-filter--source">
        <span class="activity-log-filter__label">{t("settings.activityLogSource")}</span>
        <Select
          options={activitySourceOptions}
          bind:value={activitySource}
          aria-label={t("settings.activityLogSource")}
        />
      </label>
    </div>
  {/if}
  <p class="hint activity-log-window-hint">
    {ctx.isDefaultSessionAccount
      ? t("settings.activityLogWindowDay")
      : t("settings.activityLogWindow24h")}
  </p>
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
            <th scope="col">{t("settings.activityLogColAccount")}</th>
            <th scope="col">{t("settings.activityLogColKind")}</th>
            <th scope="col">{t("settings.activityLogColDetail")}</th>
          </tr>
        </thead>
        <tbody>
          {#each activityEntries as e, i (`${e.ts}-${e.kind}-${i}`)}
            {@const msg = hubActivityMsg(e)}
            <tr>
              <td class="activity-log-td-time">{formatActivityTs(e.ts)}</td>
              <td class="activity-log-td-account" title={e.accountId || undefined}>
                {activityAccountLabel(e)}
              </td>
              <td class="activity-log-td-kind">
                <span class="activity-log-kind {activityKindClass(e.kind)}">{hubKind(e.kind)}</span>
              </td>
              <td class="activity-log-td-msg" title={msg}>{msg || "—"}</td>
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
      {t("ui.settings.diagRuntime", {
        uptime: diag.uptimeSecs,
        scanning: diag.scanning ? t("ui.yes") : t("ui.no"),
        downloads: diag.activeDownloads,
      })}
    </p>
  {/if}
  {#if ytdlp}
    <p class="hint" class:warn={ytdlp.stale}>
      {ytdlp.version
        ? t("core.settings.ytdlpVersion", {
            version: ytdlp.version,
            date: ytdlp.releaseDate ? fmtDate(ytdlp.releaseDate) : "—",
          })
        : t("core.settings.ytdlpMissing")}
      {#if ytdlp.stale}
        {" "}{t("core.settings.ytdlpStale", { days: ytdlp.ageDays ?? "?" })}
      {/if}
    </p>
    {#if ytdlp.version && jsRuntime.available}
      <p class="hint">
        {t("core.settings.ytdlpJsRuntime", { runtime: jsRuntimeLabel(jsRuntime) })}
      </p>
    {:else if ytdlp.version && jsRuntimeMissing(jsRuntime)}
      <p class="hint warn">{t("core.settings.ytdlpJsMissing")}</p>
    {/if}
    {#if canManageMachine && (ytdlp.stale || !ytdlp.version)}
      <ActionRow>
        <Button disabled={ytdlpBusy} onclick={() => void updateYtdlp()}>
          {ytdlpBusy ? t("core.settings.ytdlpUpdating") : t("core.settings.ytdlpUpdate")}
        </Button>
      </ActionRow>
    {/if}
    {#if ytdlpMsg}
      <p class="hint import-status">{ytdlpMsg}</p>
    {/if}
    {#if ytdlpErr}
      <p class="import-error" role="alert">{ytdlpErr}</p>
    {/if}
  {/if}
  <ActionRow>
    <Button
      variant="ghost"
      onclick={() =>
        void (async () => {
          await session.refreshAll();
          await loadDiag();
        })()}>{t("core.settings.checkConnection")}</Button
    >
    <Button
      variant="ghost"
      onclick={() => {
        const report = JSON.stringify(
          { app: APP_VERSION, diag, stats: session.stats, remote: ctx.remoteInfo },
          null,
          2,
        );
        void navigator.clipboard.writeText(report);
      }}>{t("settings.copyReport")}</Button
    >
  </ActionRow>
</Panel>

<style>
  .hint {
    margin: 0 0 0.85rem;
    color: var(--rk-muted);
  }

  .hint.warn {
    color: var(--rk-danger, #e85d5d);
  }

  .import-error {
    margin: 0.65rem 0 0;
    color: var(--rk-danger, #e85d5d);
    font-size: var(--rk-fs-sm);
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
    font-size: var(--rk-fs-sm);
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

  .kord-choice {
    margin: 0.85rem 0 0;
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.45rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    background: color-mix(in srgb, var(--rk-surface-3) 70%, transparent);
  }

  .kord-choice legend {
    padding: 0 0.3rem;
    font-weight: 700;
    color: var(--rk-ink);
  }

  .kord-choice__row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    gap: 0.6rem;
    align-items: center;
    cursor: pointer;
  }

  .kord-choice__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kord-choice__badge,
  .kord-choice__size {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    font-variant-numeric: tabular-nums;
  }

  .legacy-import-link {
    display: inline-block;
    margin-top: 0.85rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }
</style>
