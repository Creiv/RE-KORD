<script lang="ts">
  import { Button, QrCodeImg } from "@rekord/ui";
  import { getAccessKey, qrValueWithKey } from "../lib/accessKey";
  import { admin } from "../lib/admin.svelte";
  import { copyText } from "../lib/clipboard";
  import { t } from "../lib/i18n.svelte";

  let {
    url,
    badge = "",
    qrCaption = "",
    qrOpen = false,
  }: {
    url: string;
    /** Short tag next to the address (e.g. "recommended"). */
    badge?: string;
    qrCaption?: string;
    /** Show the QR code without a click (the best address). */
    qrOpen?: boolean;
  } = $props();

  // Starts from the prop; the user's toggle wins afterwards.
  // svelte-ignore state_referenced_locally
  let showQr = $state(qrOpen);
  let copied = $state(false);
  /** Put the access key in the QR (fragment). Off by default, never remembered. */
  let includeKey = $state(false);
  // Only the QR image carries the key: the link, copy and labels keep `url`.
  const qrValue = $derived.by(() => {
    if (!includeKey || !admin.hasAccessKey) return url;
    const key = getAccessKey();
    return key ? qrValueWithKey(url, key) : url;
  });
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    if (await copyText(url)) {
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 2000);
    } else {
      admin.notify(t("network.copyFailed"), true);
    }
  }

  $effect(() => () => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });
</script>

<div class="entry">
  <div class="line">
    <a class="url" href={url} target="_blank" rel="noopener">{url}</a>
    {#if badge}
      <span class="badge">{badge}</span>
    {/if}
    <span class="tools">
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("network.copyAria", { url })}
        title={t("network.copyAria", { url })}
        onclick={() => void copy()}
      >
        {copied ? t("network.copied") : t("network.copy")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={showQr}
        aria-label={t(showQr ? "network.qrHideAria" : "network.qrShowAria", { url })}
        onclick={() => (showQr = !showQr)}
      >
        {showQr ? t("network.qrHide") : t("network.qrShow")}
      </Button>
    </span>
  </div>
  {#if showQr}
    <figure class="qr">
      <QrCodeImg value={qrValue} size={220} alt={t("network.qrAlt", { url })} />
      {#if qrCaption}
        <figcaption>{qrCaption}</figcaption>
      {/if}
    </figure>
    {#if admin.hasAccessKey}
      <label class="check">
        <input type="checkbox" bind:checked={includeKey} />
        <span>{t("network.qrIncludeKey")}</span>
      </label>
      {#if includeKey}
        <p class="warn" role="note">{t("network.qrIncludeKeyWarn")}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .entry {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 60%, transparent);
    min-width: 0;
  }

  .entry:last-child {
    border-bottom: 0;
  }

  .line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.6rem;
    min-width: 0;
  }

  .url {
    font-weight: 600;
    color: var(--rk-ink);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .badge {
    font-size: var(--rk-fs-2xs);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rk-accent);
  }

  .tools {
    display: inline-flex;
    gap: 0.3rem;
    margin-left: auto;
  }

  .qr {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0.2rem 0 0.3rem;
  }

  .qr :global(img) {
    display: block;
    width: min(180px, 46vw);
    height: auto;
    aspect-ratio: 1 / 1;
    padding: 0.5rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    background: #fff;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: var(--rk-fs-xs);
    line-height: var(--rk-lh);
  }

  .check input {
    margin-top: 0.15rem;
  }

  .warn {
    margin: 0;
    max-width: 30rem;
    font-size: var(--rk-fs-xs);
    line-height: var(--rk-lh);
    color: var(--rk-warning);
  }

  .qr figcaption {
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
    max-width: min(220px, 60vw);
    line-height: var(--rk-lh);
  }
</style>
