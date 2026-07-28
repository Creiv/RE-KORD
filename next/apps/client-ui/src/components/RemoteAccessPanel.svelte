<script lang="ts">
  import { ActionRow, Button, Field, TextInput } from "@rekord/ui";
  import QrCodeImg from "./QrCodeImg.svelte";
  import { t } from "../lib/i18n.svelte";
  import type { RemoteAccessState } from "../lib/api";

  let {
    remote,
    busy = false,
    error = "",
    copyOk = "",
    onLogin,
    onLogout,
    onToggleShare,
    onCopyUrl,
    onRefresh,
  }: {
    remote: RemoteAccessState | null;
    busy?: boolean;
    error?: string;
    copyOk?: string;
    onLogin: () => void;
    onLogout: () => void;
    onToggleShare: () => void;
    onCopyUrl: (url: string) => void;
    onRefresh: () => void;
  } = $props();

  let loginHover = $state(false);
  let shareHover = $state(false);

  const status = $derived(remote?.status ?? "stopped");
  const lanUrl = $derived(remote?.lanUrl?.trim() || null);
  const publicUrl = $derived(
    status === "running" ? remote?.publicUrl?.trim() || null : null,
  );
  const qrUrl = $derived(publicUrl || lanUrl);
  const loggedIn = $derived(Boolean(remote?.cloudflareLoggedIn));
  const errText = $derived(error || remote?.error || "");
  const cloudflaredOk = $derived(remote?.cloudflaredAvailable !== false);

  const loginLabel = $derived(
    loggedIn
      ? loginHover
        ? t("settings.remoteLogout")
        : t("settings.remoteLoginDone")
      : t("settings.remoteLogin"),
  );

  const shareLabel = $derived(
    status === "starting"
      ? t("settings.remoteStarting")
      : status === "running"
        ? shareHover
          ? t("settings.remoteStopSharing")
          : t("settings.remoteShared")
        : t("settings.remoteStart"),
  );
</script>

<div class="remote-access">
  <div class="remote-access__main">
    <p class="hint">{t("settings.remoteHint")}</p>

    {#if lanUrl}
      <p class="hint">{t("settings.networkUrlHint", { url: lanUrl })}</p>
      <Field label={t("settings.remoteLanLabel")}>
        <TextInput value={lanUrl} readonly />
      </Field>
    {:else}
      <p class="hint">{t("settings.networkNoUrl")}</p>
    {/if}

    <ActionRow>
      <Button
        variant="ghost"
        class={loggedIn ? "is-remote-on" : ""}
        disabled={busy}
        onmouseenter={() => (loginHover = true)}
        onmouseleave={() => (loginHover = false)}
        onclick={() => (loggedIn ? onLogout() : onLogin())}
      >
        {loginLabel}
      </Button>
      <Button
        variant={status === "running" || status === "starting" ? "secondary" : "primary"}
        class={status === "starting"
          ? "is-remote-starting"
          : status === "running"
            ? "is-remote-on"
            : ""}
        disabled={busy}
        onmouseenter={() => (shareHover = true)}
        onmouseleave={() => (shareHover = false)}
        onclick={() => onToggleShare()}
      >
        {shareLabel}
      </Button>
      <Button variant="ghost" disabled={busy} onclick={() => onRefresh()}>
        {t("settings.reload")}
      </Button>
    </ActionRow>

    {#if status === "running" && publicUrl}
      <Field label={t("settings.remotePublicLabel")}>
        <TextInput value={publicUrl} readonly />
      </Field>
      <p class="hint">{t("settings.remoteUrl", { url: publicUrl })}</p>
    {:else if status === "starting"}
      <p class="hint">{t("settings.remoteStartingHint")}</p>
    {:else}
      <p class="hint">{t("settings.remoteNotShared")}</p>
    {/if}

    {#if !cloudflaredOk && status !== "running"}
      <p class="import-error" role="status">{t("settings.remoteCloudflaredMissing")}</p>
    {/if}

    {#if errText}
      <p class="import-error" role="alert">{errText}</p>
    {/if}
  </div>

  {#if qrUrl}
    <div class="remote-access__qr-wrap">
      <button
        type="button"
        class="remote-access__qr"
        title={t("settings.remoteQrCopyTitle")}
        aria-label={t("settings.remoteQrCopyAria", { url: qrUrl })}
        onclick={() => onCopyUrl(qrUrl)}
      >
        <QrCodeImg
          class="remote-access__qr-img"
          value={qrUrl}
          size={200}
          alt={t("settings.remoteQrAlt", { url: qrUrl })}
        />
      </button>
      <p class="hint remote-access__qr-caption">
        {publicUrl
          ? t("settings.remoteQrPublicCaption")
          : t("settings.remoteQrLanCaption")}
      </p>
      {#if copyOk}
        <p class="hint remote-access__qr-ok">{copyOk}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .remote-access {
    display: grid;
    gap: 1.1rem;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  @media (min-width: 720px) {
    .remote-access:has(.remote-access__qr-wrap) {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1.4rem;
    }
  }

  .remote-access__main {
    display: grid;
    gap: 0.65rem;
    min-width: 0;
  }

  .remote-access__qr-wrap {
    display: grid;
    justify-items: center;
    gap: 0.4rem;
  }

  .remote-access__qr {
    padding: 0.55rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid var(--rk-line);
    background: #fff;
    cursor: pointer;
  }

  .remote-access__qr:hover {
    border-color: color-mix(in srgb, var(--rk-accent) 35%, var(--rk-line) 65%);
  }

  .remote-access__qr:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 2px;
  }

  .remote-access__qr :global(img) {
    display: block;
    width: 200px;
    height: 200px;
  }

  .remote-access__qr-caption,
  .remote-access__qr-ok {
    margin: 0;
    text-align: center;
  }

  .remote-access__qr-ok {
    color: var(--rk-accent);
    font-weight: 650;
  }

  .remote-access :global(.rk-btn.is-remote-on) {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rk-accent) 45%, transparent);
  }

  .remote-access :global(.rk-btn.is-remote-starting) {
    opacity: 0.85;
  }
</style>
