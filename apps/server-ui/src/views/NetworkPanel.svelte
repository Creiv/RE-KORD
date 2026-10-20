<script lang="ts">
  import { ActionRow, Banner, Button, Panel } from "@rekord/ui";
  import { admin, humanTime } from "../lib/admin.svelte";
  import { t } from "../lib/i18n.svelte";
  import PowerPanel from "./PowerPanel.svelte";
  import UrlEntry from "./UrlEntry.svelte";

  const remote = $derived(admin.remote);
  const access = $derived(admin.access);
  const locked = $derived(admin.busy || !admin.canManage);
  /** Every LAN address, best first; older hubs only send `lanUrl`. */
  const lanUrls = $derived.by(() => {
    const list = (remote?.lanUrls ?? []).map((u) => u.trim()).filter(Boolean);
    const single = remote?.lanUrl?.trim();
    if (single && !list.includes(single)) list.unshift(single);
    return list;
  });
  const bestLan = $derived(lanUrls[0] ?? "");
  const publicUrl = $derived(
    remote?.status === "running" ? remote?.publicUrl?.trim() || "" : "",
  );

  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
</script>

<Panel title={t("network.lan.title")}>
  {#snippet actions()}
    <Button
      variant="secondary"
      disabled={admin.busy}
      onclick={() => void admin.loadSection("network")}
    >
      {t("common.refresh")}
    </Button>
  {/snippet}

  {#if remote}
    <div class="grid">
      <div class="cell">
        <span class="k">{t("network.lan.bind")}</span><span class="v">{remote.bind}</span>
      </div>
      <div class="cell">
        <span class="k">{t("network.lan.panel")}</span>
        <span class="v">{bestLan ? `${bestLan}/admin` : "—"}</span>
      </div>
    </div>

    <p class="sub">
      {lanUrls.length > 1
        ? t("network.lan.addressesMany", { count: lanUrls.length })
        : t("network.lan.addresses")}
    </p>
    {#if lanUrls.length === 0}
      <p class="hint">{t("network.lan.none")}</p>
    {:else}
      <!-- QR codes are for the Android app: on first launch it asks for the
           hub address, and scanning it here saves typing an IP on the phone. -->
      <div class="urls">
        {#each lanUrls as url, i (url)}
          <UrlEntry
            {url}
            badge={i === 0 && lanUrls.length > 1 ? t("network.lan.best") : ""}
            qrCaption={t("network.lan.qrCaption")}
            qrOpen={i === 0}
          />
        {/each}
      </div>
    {/if}
    <p class="hint">
      {lanUrls.length > 1 ? t("network.lan.hintMany") : t("network.lan.hint")}
    </p>
  {/if}
  {#if admin.hasAccessKey}
    <div class="keyrow">
      <span class="hint">{t("network.accessKey.stored")}</span>
      <Button variant="ghost" size="sm" onclick={() => admin.forgetAccessKey()}>
        {t("network.accessKey.forget")}
      </Button>
    </div>
  {/if}
</Panel>

<Panel title={t("network.remote.title")}>
  {#if remote}
    <div class="grid">
      <div class="cell">
        <span class="k">{t("network.remote.tunnel")}</span>
        <span class="v">{t(`network.remote.status.${remote.status}`)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("network.remote.publicUrl")}</span>
        <span class="v">{remote.publicUrl ?? "—"}</span>
      </div>
      <div class="cell">
        <span class="k">{t("network.remote.startedAt")}</span>
        <span class="v">{humanTime(remote.startedAt)}</span>
      </div>
      <div class="cell">
        <span class="k">cloudflared</span>
        <span class="v">
          {remote.cloudflaredAvailable ? t("common.available") : t("common.notFound")}
        </span>
      </div>
      <div class="cell">
        <span class="k">{t("network.remote.cfLogin")}</span>
        <span class="v">
          {remote.cloudflareLoggedIn ? t("network.remote.loggedIn") : t("network.remote.loggedOut")}
        </span>
      </div>
      <div class="cell">
        <span class="k">{t("network.remote.publicIp")}</span>
        <span class="v">{admin.publicIp ?? "—"}</span>
      </div>
    </div>

    {#if publicUrl}
      <div class="urls">
        <UrlEntry url={publicUrl} qrCaption={t("network.remote.qrCaption")} qrOpen />
      </div>
    {/if}

    {#if remote.error}
      <Banner tone="error"
        >{remote.errorCode && t(`network.remote.errorCode.${remote.errorCode}`) !== `network.remote.errorCode.${remote.errorCode}`
          ? t(`network.remote.errorCode.${remote.errorCode}`)
          : remote.error}</Banner
      >
    {/if}
    {#if !remote.cloudflaredAvailable}
      <Banner tone="info">{t("network.remote.noCloudflared")}</Banner>
    {/if}

    <ActionRow>
      {#if remote.status === "running" || remote.status === "starting"}
        <Button variant="secondary" disabled={locked} onclick={() => void admin.remoteStop()}>
          {t("network.remote.stop")}
        </Button>
      {:else}
        <Button disabled={locked} onclick={() => void admin.remoteStart()}>
          {t("network.remote.start")}
        </Button>
      {/if}
      {#if remote.cloudflareLoggedIn}
        <Button variant="ghost" disabled={locked} onclick={() => void admin.remoteLogout()}>
          {t("network.remote.logout")}
        </Button>
      {:else}
        <Button variant="ghost" disabled={locked} onclick={() => void admin.remoteLogin()}>
          {t("network.remote.login")}
        </Button>
      {/if}
      <Button variant="ghost" disabled={admin.busy} onclick={() => void admin.loadPublicIp()}>
        {t("network.remote.readIp")}
      </Button>
    </ActionRow>
  {/if}
</Panel>

{#if admin.power}
  <PowerPanel power={admin.power} />
{/if}

<Panel title={t("network.machine.title")}>
  <p class="hint">{t("network.machine.hint")}</p>
  {#if access}
    <div class="grid">
      <div class="cell">
        <span class="k">{t("network.machine.defaultAccount")}</span>
        <span class="v">{yesNo(access.isDefaultAccount)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("network.machine.local")}</span>
        <span class="v">{yesNo(access.local)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("network.machine.canManage")}</span>
        <span class="v">{yesNo(access.canManageMachine)}</span>
      </div>
    </div>
    <label class="check">
      <input
        type="checkbox"
        checked={access.allowRemoteAdmin}
        disabled={admin.busy || !access.local || !access.isDefaultAccount}
        onchange={(e) => void admin.setRemoteAdmin(e.currentTarget.checked)}
      />
      <span>{t("network.machine.allowRemote")}</span>
    </label>
    {#if !access.local}
      <Banner tone="info">{t("network.machine.remoteNote")}</Banner>
    {/if}
  {/if}
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.55rem 1.1rem;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
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
    margin: 0.4rem 0 0.8rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .keyrow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.8rem;
    margin-top: 0.8rem;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    margin: 0.8rem 0 0;
    line-height: var(--rk-lh);
  }

  .check input {
    margin-top: 0.2rem;
  }

  .sub {
    margin: 0.9rem 0 0.2rem;
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .urls {
    display: flex;
    flex-direction: column;
    margin: 0 0 0.6rem;
  }
</style>
