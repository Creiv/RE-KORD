<script lang="ts">
  import { ActionRow, Button } from "@rekord/ui";
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
  }: {
    remote: RemoteAccessState | null;
    busy?: boolean;
    error?: string;
    copyOk?: string;
    onLogin: () => void;
    onLogout: () => void;
    onToggleShare: () => void;
    onCopyUrl: (url: string) => void;
  } = $props();

  let loginHover = $state(false);
  let shareHover = $state(false);

  const status = $derived(remote?.status ?? "stopped");
  const lanUrl = $derived(remote?.lanUrl?.trim() || null);
  const publicUrl = $derived(
    status === "running" ? remote?.publicUrl?.trim() || null : null,
  );
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

  /** Split i18n `…{{url}}…` so the URL can render as a clickable link. */
  function urlHintParts(key: string): { before: string; after: string } {
    const marker = "\u0001";
    const [before = "", after = ""] = t(key, { url: marker }).split(marker);
    return { before, after };
  }

  const lanHint = $derived(urlHintParts("settings.networkUrlHint"));
  const publicHint = $derived(urlHintParts("settings.remoteUrl"));
</script>

<div class="remote-access">
  <div class="remote-access__main">
    {#if lanUrl}
      <p class="hint">
        {lanHint.before}<a
          class="remote-access__link"
          href={lanUrl}
          target="_blank"
          rel="noopener noreferrer">{lanUrl}</a
        >{lanHint.after}
      </p>
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
    </ActionRow>

    {#if status === "running" && publicUrl}
      <p class="hint">
        {publicHint.before}<a
          class="remote-access__link"
          href={publicUrl}
          target="_blank"
          rel="noopener noreferrer">{publicUrl}</a
        >{publicHint.after}
      </p>
    {:else if status === "starting"}
      <p class="hint">{t("settings.remoteStartingHint")}</p>
    {/if}

    {#if !cloudflaredOk && status !== "running"}
      <p class="import-error" role="status">{t("settings.remoteCloudflaredMissing")}</p>
    {/if}

    {#if errText}
      <p class="import-error" role="alert">{errText}</p>
    {/if}
  </div>

  {#if status === "running" && publicUrl}
    <div class="remote-access__qr-wrap">
      <button
        type="button"
        class="remote-access__qr"
        title={t("settings.remoteQrCopyTitle")}
        aria-label={t("settings.remoteQrCopyAria", { url: publicUrl })}
        onclick={() => onCopyUrl(publicUrl)}
      >
        <QrCodeImg
          class="remote-access__qr-img"
          value={publicUrl}
          size={220}
          alt={t("settings.remoteQrAlt", { url: publicUrl })}
        />
      </button>
      {#if copyOk}
        <p class="hint remote-access__qr-ok">{copyOk}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .remote-access {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1rem;
    width: 100%;
    text-align: left;
  }

  .remote-access__main {
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .remote-access__main > :global(p) {
    margin: 0;
  }

  .remote-access__link {
    color: var(--rk-accent);
    text-decoration: underline;
    text-underline-offset: 0.12em;
    word-break: break-all;
  }

  .remote-access__link:hover {
    color: color-mix(in srgb, var(--rk-accent) 85%, white);
  }

  .remote-access__qr-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
  }

  .remote-access__qr {
    margin: 0;
    padding: 0.5rem;
    width: fit-content;
    border-radius: var(--rk-radius-lg);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-2, #fff) 76%, transparent);
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;
  }

  .remote-access__qr:hover {
    border-color: color-mix(in srgb, var(--rk-accent) 42%, var(--rk-line) 58%);
  }

  .remote-access__qr:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 2px;
  }

  .remote-access__qr :global(img),
  .remote-access__qr-img {
    display: block;
    width: min(160px, 42vw);
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    border-radius: 0.45rem;
  }

  .remote-access__qr-ok {
    margin: 0;
    text-align: center;
    max-width: min(180px, 70vw);
    color: var(--rk-accent);
    font-weight: 650;
  }

  .remote-access :global(.rk-btn.is-remote-on) {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rk-accent) 45%, transparent);
  }

  .remote-access :global(.rk-btn.is-remote-starting) {
    opacity: 0.85;
  }

  @media (min-width: 720px) {
    .remote-access:has(.remote-access__qr-wrap) {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 1.25rem;
    }

    .remote-access__main {
      grid-column: 1;
      grid-row: 1;
    }

    .remote-access__qr-wrap {
      grid-column: 2;
      grid-row: 1;
      align-items: flex-end;
      align-self: start;
      justify-self: end;
    }

    .remote-access__qr-ok {
      text-align: right;
    }
  }

  @media (max-width: 719px) {
    .remote-access :global(.rk-actions) {
      flex-direction: column;
      align-items: stretch;
      width: 100%;
    }

    .remote-access :global(.rk-actions .rk-btn) {
      width: 100%;
      justify-content: center;
    }
  }
</style>
