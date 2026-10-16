<script lang="ts">
  import { ActionRow, Banner, Button, Field, Panel, TextInput } from "@rekord/ui";
  import { admin } from "../lib/admin.svelte";
  import { formatDateTime, t, tp } from "../lib/i18n.svelte";

  let cookieInput = $state<HTMLInputElement | null>(null);

  const cfg = $derived(admin.config);
  const locked = $derived(admin.busy || !admin.canManage);
  // Only the token flag: hubs up to 5.1 sent `discogsConfigured: true` always.
  const discogsTokenSet = $derived(!!cfg?.discogsTokenConfigured);

  function onCookiePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void admin.uploadCookies(file);
  }
</script>

<Panel title="YouTube (yt-dlp)">
  {#if cfg}
    <div class="state">
      <span class="k">{t("integrations.yt.download")}</span>
      <span class="v">
        {cfg.ytdlpEnabled ? t("common.available") : t("integrations.yt.missing")}
      </span>
      <span class="k">{t("integrations.yt.cookies")}</span>
      <span class="v">
        {cfg.youtubeCookiesConfigured
          ? cfg.youtubeCookiesLabel || t("integrations.yt.cookiesSet")
          : cfg.youtubeCookiesPresent
            ? t("integrations.yt.cookiesInvalid")
            : t("integrations.yt.cookiesUnset")}
      </span>
      {#if cfg.youtubeCookiesConfigured && cfg.youtubeCookiesEntries != null}
        <span class="k">{t("integrations.yt.cookiesEntriesLabel")}</span>
        <span class="v">
          {tp("integrations.yt.cookiesEntries", cfg.youtubeCookiesEntries, {
            yt: cfg.youtubeCookiesYoutubeEntries ?? 0,
          })}
        </span>
      {/if}
      {#if cfg.youtubeCookiesPresent && cfg.youtubeCookiesUpdatedAt}
        <span class="k">{t("integrations.yt.cookiesUpdated")}</span>
        <span class="v">{formatDateTime(cfg.youtubeCookiesUpdatedAt)}</span>
      {/if}
    </div>
    {#if cfg.youtubeCookiesConfigured && cfg.youtubeCookiesYoutubeEntries === 0}
      <Banner tone="error">{t("integrations.yt.cookiesNoYoutube")}</Banner>
    {/if}
    {#if cfg.youtubeCookiesLockedByEnv}
      <Banner tone="info">{t("integrations.yt.lockedByEnv")}</Banner>
    {:else}
      <ActionRow>
        <Button
          disabled={locked || cfg.youtubeCookiesWritable === false}
          onclick={() => cookieInput?.click()}
        >
          {t("integrations.yt.upload")}
        </Button>
        {#if cfg.youtubeCookiesConfigured}
          <Button
            variant="ghost"
            disabled={locked || cfg.youtubeCookiesWritable === false}
            onclick={() => void admin.clearCookies()}
          >
            {t("common.remove")}
          </Button>
        {/if}
      </ActionRow>
    {/if}
    <input
      bind:this={cookieInput}
      class="hidden-file"
      type="file"
      accept=".txt,text/plain"
      onchange={onCookiePicked}
    />
    <p class="hint">{t("integrations.yt.hint")}</p>
    <p class="hint">{t("integrations.yt.howTo")}</p>
  {/if}
</Panel>

<Panel title="Discogs">
  {#if cfg}
    <div class="state">
      <span class="k">{t("integrations.discogs.token")}</span>
      <span class="v">
        {discogsTokenSet
          ? t("integrations.discogs.set")
          : t("integrations.discogs.unset")}
      </span>
    </div>
    {#if cfg.discogsLockedByEnv}
      <Banner tone="info">{t("integrations.discogs.lockedByEnv")}</Banner>
    {:else}
      <Field label={t("integrations.discogs.field")}>
        <TextInput
          type="password"
          bind:value={admin.discogsToken}
          placeholder={t("integrations.discogs.placeholder")}
          disabled={locked || cfg.discogsWritable === false}
        />
      </Field>
      <ActionRow>
        <Button
          disabled={locked || !admin.discogsToken.trim() || cfg.discogsWritable === false}
          onclick={() => void admin.saveDiscogsToken()}
        >
          {t("integrations.discogs.save")}
        </Button>
        {#if discogsTokenSet}
          <Button
            variant="ghost"
            disabled={locked || cfg.discogsWritable === false}
            onclick={() => void admin.clearDiscogsToken()}
          >
            {t("common.remove")}
          </Button>
        {/if}
      </ActionRow>
    {/if}
    <p class="hint">{t("integrations.discogs.hint")}</p>
  {/if}
</Panel>

{#if !admin.canManage}
  <Banner tone="info">{t("integrations.machineOnly")}</Banner>
{/if}

<style>
  .state {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.8rem;
    align-items: baseline;
    margin-bottom: 0.8rem;
  }

  .k {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .v {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .hint {
    margin: 0.7rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .hidden-file {
    display: none;
  }
</style>
