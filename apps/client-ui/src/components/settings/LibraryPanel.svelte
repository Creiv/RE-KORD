<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ActionRow, Button, Field, Panel, TextInput } from "@rekord/ui";
  import DiskSpaceMeter from "../DiskSpaceMeter.svelte";
  import IntegrationList from "../IntegrationList.svelte";
  import IntegrationRow from "../IntegrationRow.svelte";
  import { api, formatBytes, type HubConfig } from "../../lib/api";
  import { fmtDate, fmtRelative, t } from "../../lib/i18n.svelte";
  import { session } from "../../lib/session.svelte";
  import type { SettingsAccounts } from "./settingsAccounts.svelte";

  let { ctx }: { ctx: SettingsAccounts } = $props();

  let hubConfig = $state<HubConfig | null>(null);
  let integBusy = $state(false);
  let integErr = $state("");
  let integOk = $state("");
  let discogsDraft = $state("");
  let cookiesInput: HTMLInputElement | undefined = $state();

  const canManageMachine = $derived(ctx.canManageMachine);
  const ytActionsOpen = $derived(
    canManageMachine &&
      !hubConfig?.youtubeCookiesLockedByEnv &&
      hubConfig?.youtubeCookiesWritable !== false,
  );
  const discogsActionsOpen = $derived(
    canManageMachine && !hubConfig?.discogsLockedByEnv && hubConfig?.discogsWritable !== false,
  );

  async function loadHubConfig() {
    try {
      hubConfig = await api.config();
    } catch {
      hubConfig = null;
    }
  }

  onMount(() => {
    void loadHubConfig();
    void ctx.load();
  });

  // The hub answers per account: reload when the session switches account —
  // only then, not every time the account list is (re)loaded.
  let lastAccount = session.activeAccountId;
  $effect(() => {
    const bound = session.activeAccountId;
    if (bound === lastAccount) return;
    lastAccount = bound;
    untrack(() => void loadHubConfig());
  });

  async function integrationCall(run: () => Promise<HubConfig>, okKey: string) {
    if (!canManageMachine) return;
    integBusy = true;
    integErr = "";
    integOk = "";
    try {
      hubConfig = await run();
      integOk = t(okKey);
    } catch (e) {
      integErr = e instanceof Error ? e.message : String(e);
    } finally {
      integBusy = false;
    }
  }

  async function onCookiesPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await integrationCall(() => api.uploadYoutubeCookies(file), "settings.youtubeCookiesSaved");
  }

  function clearCookies() {
    return integrationCall(() => api.clearYoutubeCookies(), "settings.youtubeCookiesCleared");
  }

  async function saveDiscogs() {
    await integrationCall(async () => {
      const cfg = await api.setDiscogsToken(discogsDraft);
      discogsDraft = "";
      return cfg;
    }, "settings.discogsTokenSaved");
  }

  function clearDiscogs() {
    return integrationCall(() => api.clearDiscogsToken(), "settings.discogsTokenCleared");
  }
</script>

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
    <Button disabled={integBusy || !discogsDraft.trim()} onclick={() => void saveDiscogs()}>
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
    {t("core.settings.libraryHint", {
      at: session.stats?.last_scan_at
        ? `${fmtDate(session.stats.last_scan_at, "datetime")} (${fmtRelative(session.stats.last_scan_at)})`
        : t("core.settings.neverScanned"),
    })}
  </p>
  <ActionRow>
    <Button
      variant="ghost"
      disabled={!canManageMachine}
      onclick={() => void session.refreshAll({ rescan: true })}
      >{t("settings.libraryReload")}</Button
    >
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
        <p class="integration-row__lead">{t("settings.youtubeCookiesHowTo")}</p>
      {/snippet}
      {#snippet status()}
        {#if hubConfig?.youtubeCookiesConfigured}
          {t("settings.youtubeCookiesActive", {
            name: hubConfig.youtubeCookiesLabel || "cookies.txt",
          })}
          {#if hubConfig.youtubeCookiesUpdatedAt}
            {" · "}{t("settings.youtubeCookiesUpdated", {
              when: fmtRelative(hubConfig.youtubeCookiesUpdatedAt),
            })}
          {/if}
          {#if hubConfig.youtubeCookiesEntries != null}
            {" · "}{t("settings.youtubeCookiesEntries", {
              n: hubConfig.youtubeCookiesEntries,
              yt: hubConfig.youtubeCookiesYoutubeEntries ?? 0,
            })}
          {/if}
        {:else if hubConfig?.youtubeCookiesPresent}
          {t("settings.youtubeCookiesInvalid")}
        {:else}
          {t("settings.youtubeCookiesMissing")}
        {/if}
      {/snippet}
      {#snippet aside()}
        {#if hubConfig?.youtubeCookiesConfigured && hubConfig.youtubeCookiesYoutubeEntries === 0}
          <p class="integration-row__warn">{t("settings.youtubeCookiesNoYoutube")}</p>
        {/if}
        {#if hubConfig?.youtubeCookiesLockedByEnv}
          <p class="integration-row__warn">
            {t("settings.youtubeCookiesEnvLocked")}
          </p>
        {:else if !ctx.isDefaultSessionAccount}
          <p class="integration-row__lead">
            {t("settings.defaultAccountOnly")}
          </p>
        {:else if !canManageMachine || hubConfig?.youtubeCookiesWritable === false}
          <p class="integration-row__lead">
            {t("settings.machineOpsHubOnly")}
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
          class="rk-link"
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
        {:else if !ctx.isDefaultSessionAccount}
          <p class="integration-row__lead">
            {t("settings.defaultAccountOnly")}
          </p>
        {:else if !canManageMachine || hubConfig?.discogsWritable === false}
          <p class="integration-row__lead">
            {t("settings.machineOpsHubOnly")}
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

<style>
  .hint {
    margin: 0 0 0.85rem;
    color: var(--rk-muted);
  }

  .import-error {
    margin: 0.65rem 0 0;
    color: var(--rk-danger, #e85d5d);
    font-size: var(--rk-fs-sm);
  }

  .import-status {
    margin-top: 0.65rem;
  }
</style>
