<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, BrandLogo, Button, Segmented, TextInput } from "@rekord/ui";
  import AccessKeyScreen from "./AccessKeyScreen.svelte";
  import { clearAccessKey, setAccessKey, type AccessKeyReason } from "../lib/accessKey";
  import { isDesktopShell } from "../lib/platform/env";
  import type { Account } from "../lib/account";
  import { connectGate, probeHub, type ProbeFailure } from "../lib/connect.svelte";
  import {
    DEFAULT_HUB_PORT,
    formatHubLabel,
    guessHubMode,
    hubBaseFromParts,
    hubBaseFromQr,
    parseHubAddress,
  } from "../lib/hubAddress";
  import { i18n, t, type AppLocale } from "../lib/i18n.svelte";
  import { normalizeLocale } from "../lib/userPrefs";
  import { qrScannerAvailable, scanQrCode } from "../lib/qrScan";

  let {
    savedBase = "",
    dismissible = false,
    onconnected,
    ondismiss,
  }: {
    /** Address of the last connection: prefilled in the fields. */
    savedBase?: string;
    /** Reopened from settings, with the app behind: going back is possible. */
    dismissible?: boolean;
    onconnected: (base: string, accountId: string) => void;
    ondismiss?: () => void;
  } = $props();

  type Step = "address" | "accounts";

  let step = $state<Step>("address");
  let mode = $state<"local" | "public">("local");
  let host = $state("");
  let port = $state(DEFAULT_HUB_PORT);
  let publicUrl = $state("");
  let busy = $state(false);
  let scanning = $state(false);
  let canScan = $state(false);
  let error = $state("");
  let accounts = $state<Account[]>([]);
  let defaultAccountId = $state("");
  let connectedBase = $state("");
  let openingId = $state("");
  /** The hub just probed wants an access key: ask for it before the accounts. */
  let keyStep = $state<{ base: string; reason: AccessKeyReason; noticeKey?: string } | null>(null);
  /** Key that came with a scanned QR: dropped again if the hub refuses it. */
  let qrKeyBase = "";
  /** Desktop server flavor: why the built-in hub did not start, if it did not. */
  let embeddedHubError = $state("");

  const candidateBase = $derived(
    mode === "public"
      ? (parseHubAddress(publicUrl)?.base ?? null)
      : hubBaseFromParts(host, port),
  );

  const hubLabel = $derived(connectedBase ? formatHubLabel(connectedBase) : "");

  onMount(() => {
    applySaved(savedBase);
    void qrScannerAvailable().then((ok) => {
      canScan = ok;
    });
    void loadEmbeddedHubError();
  });

  /** Only the server flavor registers the command; elsewhere the call fails quietly. */
  async function loadEmbeddedHubError() {
    if (!isDesktopShell()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const code = await invoke<string | null>("embedded_hub_error");
      if (code === "access_key_config") embeddedHubError = t("connect.embeddedHubKeyError");
    } catch {
      /* not the server flavor */
    }
  }

  function applySaved(base: string) {
    const parsed = parseHubAddress(base);
    if (!parsed) return;
    if (guessHubMode(base) === "public") {
      mode = "public";
      publicUrl = parsed.base;
    } else {
      mode = "local";
      host = parsed.host;
      port = parsed.port;
    }
  }

  function describeFailure(failure: ProbeFailure): string {
    switch (failure.reason) {
      case "timeout":
        return t("connect.errTimeout");
      case "http":
        return t("connect.errHttp", { status: failure.status });
      case "not-hub":
        return t("connect.errNotHub");
      case "no-accounts":
        return t("connect.errNoAccounts");
      default:
        return t("connect.errUnreachable");
    }
  }

  async function connect() {
    error = "";
    const base = candidateBase;
    if (!base) {
      error = mode === "public" ? t("connect.errPublicUrl") : t("connect.errHost");
      return;
    }
    busy = true;
    const probe = await probeHub(base);
    busy = false;
    if (!probe.ok) {
      if (probe.reason === "access-key") {
        // A key from the QR that the hub refuses must not stay on the device.
        const qrRefused = qrKeyBase === base && probe.detail === "invalid";
        if (qrRefused) clearAccessKey(base);
        qrKeyBase = "";
        keyStep = {
          base,
          reason: probe.detail,
          noticeKey: qrRefused ? "accessKey.errQrInvalid" : undefined,
        };
        return;
      }
      error = describeFailure(probe);
      return;
    }
    qrKeyBase = "";
    connectedBase = base;
    accounts = probe.accounts;
    defaultAccountId = probe.defaultAccountId;
    step = "accounts";
    // A hub with a single profile is not a choice: go in and look at the library.
    if (probe.accounts.length === 1) enter(probe.accounts[0].id);
  }

  function enter(accountId: string) {
    if (!connectedBase || openingId) return;
    openingId = accountId;
    onconnected(connectedBase, accountId);
  }

  function backToAddress() {
    step = "address";
    error = "";
    openingId = "";
    accounts = [];
  }

  async function scan() {
    error = "";
    scanning = true;
    const outcome = await scanQrCode();
    scanning = false;
    if (outcome.status === "cancelled") return;
    if (outcome.status === "denied") {
      error = t("connect.errCameraDenied");
      return;
    }
    if (outcome.status === "error") {
      error = t("connect.errScan");
      return;
    }
    const qr = hubBaseFromQr(outcome.text);
    if (!qr) {
      error = t("connect.errQrNotHub");
      return;
    }
    applySaved(qr.base);
    if (qr.accessKey) {
      // Stored for exactly this hub; the probe below checks it right away.
      setAccessKey(qr.base, qr.accessKey);
      qrKeyBase = qr.base;
    }
    // The QR was scanned to connect, not to fill in a field.
    await connect();
  }

  function setLocale(next: AppLocale) {
    i18n.setLocale(next);
  }

  function initial(name: string): string {
    return (name.trim()[0] || "?").toUpperCase();
  }
</script>

{#if keyStep}
  <AccessKeyScreen
    base={keyStep.base}
    reason={keyStep.reason}
    noticeKey={keyStep.noticeKey}
    onaccepted={() => {
      keyStep = null;
      // Same address, now with the key: on to the accounts.
      void connect();
    }}
    oncancel={() => (keyStep = null)}
  />
{:else}
<div class="connect">
  <div class="connect__lang">
    <span class="connect__lang-label" id="connect-lang-label">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
      </svg>
      {t("settings.language")}
    </span>
    <Segmented
      ariaLabel={t("settings.language")}
      value={i18n.locale}
      onchange={(v) => setLocale(normalizeLocale(v))}
      options={[
        { value: "it", label: "Italiano" },
        { value: "en", label: "English" },
        { value: "de", label: "Deutsch" },
      ]}
    />
  </div>

  <main class="connect__shell">
    <section class="connect__card rk-surface-card" class:is-accounts={step === "accounts"}>
      <header class="connect__head">
        <div class="connect__brand">
          <BrandLogo size="lg" />
          <p class="connect__eyebrow">RE-KORD</p>
        </div>
        {#if step === "address"}
          <h1 class="connect__title">{t("connect.title")}</h1>
          <p class="connect__lead">{t("connect.lead")}</p>
        {:else}
          <h1 class="connect__title">{t("connect.accountsTitle")}</h1>
          <p class="connect__lead">{t("connect.accountsLead", { hub: hubLabel })}</p>
        {/if}
      </header>

      {#if step === "address"}
        <div class="connect__body">
          <div class="connect__field">
            <span class="connect__label" id="connect-mode-label">
              {t("connect.mode")}
            </span>
            <Segmented
              block
              class="connect__seg"
              ariaLabel={t("connect.mode")}
              value={mode}
              onchange={(v) => {
                mode = v === "public" ? "public" : "local";
                error = "";
              }}
              options={[
                { value: "local", label: t("connect.modeLocal") },
                { value: "public", label: t("connect.modePublic") },
              ]}
            />
          </div>

          {#if mode === "local"}
            <div class="connect__hostrow">
              <label class="connect__field">
                <span class="connect__label">{t("connect.host")}</span>
                <TextInput
                  bind:value={host}
                  placeholder="192.168.1.20"
                  autocomplete="off"
                  spellcheck={false}
                  inputmode="url"
                  oninput={() => (error = "")}
                />
              </label>
              <label class="connect__field">
                <span class="connect__label">{t("connect.port")}</span>
                <TextInput
                  bind:value={port}
                  placeholder={DEFAULT_HUB_PORT}
                  autocomplete="off"
                  spellcheck={false}
                  inputmode="numeric"
                  oninput={() => (error = "")}
                />
              </label>
            </div>
          {:else}
            <label class="connect__field">
              <span class="connect__label">{t("connect.publicUrl")}</span>
              <TextInput
                bind:value={publicUrl}
                placeholder={t("connect.publicUrlPh")}
                autocomplete="off"
                spellcheck={false}
                inputmode="url"
                oninput={() => (error = "")}
              />
            </label>
          {/if}

          <p class="connect__hint">{t("connect.hint")}</p>
        </div>
      {:else}
        <div class="connect__accounts">
          {#each accounts as account (account.id)}
            {@const isCurrent = dismissible && account.id === connectGate.currentAccountId}
            <button
              type="button"
              class="connect__account"
              class:is-current={isCurrent}
              aria-current={isCurrent ? "true" : undefined}
              class:is-opening={openingId === account.id}
              disabled={Boolean(openingId)}
              onclick={() => enter(account.id)}
            >
              <span class="connect__avatar" aria-hidden="true">{initial(account.name)}</span>
              <span class="connect__account-text">
                <span class="connect__account-name">{account.name}</span>
                {#if isCurrent || account.id === defaultAccountId}
                  <span class="connect__badges">
                    {#if isCurrent}
                      <span class="connect__badge connect__badge--current">{t("ui.connect.currentAccount")}</span>
                    {/if}
                    {#if account.id === defaultAccountId}
                      <span class="connect__badge">{t("connect.defaultAccount")}</span>
                    {/if}
                  </span>
                {/if}
              </span>
              <span class="connect__chevron" aria-hidden="true">›</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if embeddedHubError && step === "address"}
        <div class="connect__error">
          <Banner tone="error">{embeddedHubError}</Banner>
        </div>
      {/if}
      {#if error}
        <div class="connect__error">
          <Banner tone="error">{error}</Banner>
        </div>
      {/if}

      <div class="connect__actions">
        {#if step === "address"}
          <Button
            class="connect__cta"
            disabled={busy || scanning || !candidateBase}
            onclick={() => void connect()}
          >
            {busy ? t("connect.connecting") : t("connect.connect")}
          </Button>
          {#if canScan}
            <Button
              class="connect__cta"
              variant="secondary"
              disabled={busy || scanning}
              onclick={() => void scan()}
            >
              {scanning ? t("connect.scanning") : t("connect.scanQr")}
            </Button>
          {/if}
          {#if dismissible && ondismiss}
            <!-- Leave without changing anything: a side action, not a peer
                 of «Connect». -->
            <Button class="connect__quiet" variant="link" onclick={ondismiss}>
              {t("connect.cancel")}
            </Button>
          {/if}
        {:else}
          <Button
            class="connect__quiet"
            variant="link"
            disabled={Boolean(openingId)}
            onclick={backToAddress}
          >
            <span aria-hidden="true">‹</span>
            {t("connect.changeHub")}
          </Button>
        {/if}
      </div>
    </section>
  </main>
</div>
{/if}

<style>
  .connect {
    display: flex;
    flex-direction: column;
    min-height: var(--rk-app-vh);
    background:
      radial-gradient(
        ellipse 80% 60% at 50% 0%,
        color-mix(in srgb, var(--rk-accent) 10%, transparent) 0%,
        transparent 60%
      ),
      var(--rk-bg);
  }

  .connect__lang {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--rk-space-md);
    padding: calc(env(safe-area-inset-top, 0px) + var(--rk-space-xl))
      calc(env(safe-area-inset-right, 0px) + var(--rk-space-xl)) 0
      calc(env(safe-area-inset-left, 0px) + var(--rk-space-xl));
  }

  .connect__shell {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--rk-space-2xl) calc(env(safe-area-inset-right, 0px) + var(--rk-space-xl))
      calc(env(safe-area-inset-bottom, 0px) + var(--rk-space-2xl))
      calc(env(safe-area-inset-left, 0px) + var(--rk-space-xl));
  }

  .connect__card {
    width: 100%;
    max-width: 26rem;
    padding: var(--rk-space-2xl);
    /* The account list is wider than the two address fields. */
    transition: max-width 0.22s ease;
  }

  .connect__card.is-accounts {
    max-width: 32rem;
  }

  .connect__brand {
    display: flex;
    align-items: center;
    gap: var(--rk-space-lg);
  }

  .connect__eyebrow {
    margin: 0;
    color: var(--rk-accent-2);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: var(--rk-fs-eyebrow);
    font-weight: 800;
  }

  .connect__title {
    margin: var(--rk-space-lg) 0 0;
    font-family: var(--rk-display);
    font-size: var(--rk-fs-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: var(--rk-lh-tight);
  }

  .connect__lead {
    margin: var(--rk-space-sm) 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-md);
    line-height: var(--rk-lh);
  }

  .connect__body {
    display: grid;
    gap: var(--rk-space-lg);
    margin-top: var(--rk-space-xl);
  }

  .connect__field {
    display: grid;
    gap: var(--rk-space-xs);
    min-width: 0;
  }

  .connect__label {
    font-size: var(--rk-fs-sm);
    font-weight: 600;
    color: var(--rk-muted-strong);
  }

  /* First launch by finger on a phone: the two modes are targets, not labels. */
  .connect__body :global(.connect__seg .rk-seg__opt) {
    min-height: calc(var(--rk-tap-min) - 6px);
  }

  .connect__hostrow {
    display: grid;
    /* The IP takes what's left, the port four digits and that's it. */
    grid-template-columns: minmax(0, 1fr) 6rem;
    gap: var(--rk-space-lg);
  }

  .connect__hint {
    margin: 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
    line-height: var(--rk-lh);
  }

  .connect__accounts {
    display: grid;
    gap: var(--rk-space-md);
    margin-top: var(--rk-space-xl);
  }

  .connect__account {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--rk-space-lg);
    width: 100%;
    min-height: var(--rk-tap-min);
    padding: var(--rk-space-lg);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    background: color-mix(in srgb, var(--rk-surface-2) 78%, transparent);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      opacity 0.15s ease;
  }

  .connect__account:hover:not(:disabled) {
    border-color: var(--rk-line-strong);
    background: color-mix(in srgb, var(--rk-surface-3) 82%, transparent);
  }

  .connect__account:disabled {
    cursor: default;
    opacity: 0.72;
  }

  .connect__account.is-opening {
    border-color: color-mix(in srgb, var(--rk-accent) 42%, var(--rk-line) 58%);
    background: color-mix(in srgb, var(--rk-accent) 11%, var(--rk-surface-2) 89%);
    opacity: 1;
  }

  .connect__avatar {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border-radius: var(--rk-radius-round);
    background: color-mix(in srgb, var(--rk-accent) 18%, var(--rk-surface-3) 82%);
    color: var(--rk-accent);
    font-weight: 850;
  }

  .connect__account-text {
    display: grid;
    gap: var(--rk-space-3xs);
    min-width: 0;
  }

  .connect__account-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--rk-fs-base);
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .connect__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .connect__account.is-current {
    border-color: color-mix(in srgb, var(--rk-accent-2) 50%, var(--rk-line));
  }

  .connect__badge--current {
    border-color: color-mix(in srgb, var(--rk-accent-2) 40%, var(--rk-line));
    background: var(--rk-accent2-soft);
    color: color-mix(in srgb, var(--rk-accent-2) 80%, var(--rk-ink));
  }

  .connect__badge {
    justify-self: start;
    font-size: var(--rk-fs-1);
    font-weight: 650;
    line-height: 1;
    padding: 0.32em 0.62em;
    border-radius: var(--rk-radius-round);
    border: 1px solid color-mix(in srgb, var(--rk-accent) 30%, var(--rk-line) 70%);
    background: color-mix(in srgb, var(--rk-accent) 8%, var(--rk-surface-3) 92%);
    color: color-mix(in srgb, var(--rk-accent) 80%, var(--rk-muted) 20%);
  }

  .connect__chevron {
    font-size: var(--rk-fs-xl);
    line-height: 1;
    color: var(--rk-muted);
    opacity: 0.72;
  }

  .connect__error {
    margin-top: var(--rk-space-xl);
  }

  .connect__actions {
    display: grid;
    gap: var(--rk-space-md);
    margin-top: var(--rk-space-2xl);
  }

  /* The flow's buttons span the full row: here there is one thing to do per
     screen, and on the phone the row is the easiest target to hit. */
  .connect__actions :global(.connect__cta) {
    width: 100%;
    min-height: var(--rk-tap-min);
  }

  .connect__actions :global(.connect__quiet) {
    justify-self: center;
    font-size: var(--rk-fs-3);
    color: var(--rk-muted-strong);
  }

  .connect__lang-label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--rk-fs-2);
    font-weight: 600;
    color: var(--rk-muted);
  }

  .connect__lang-label svg {
    width: 1rem;
    height: 1rem;
  }

  @media (max-width: 559.98px) {
    .connect__card {
      padding: var(--rk-space-xl);
    }

    .connect__shell {
      /* On the phone the card takes the full width: centring it in 390px would leave
         two margins and a narrow address field. */
      align-items: flex-start;
      padding-top: var(--rk-space-xl);
    }
  }
</style>
