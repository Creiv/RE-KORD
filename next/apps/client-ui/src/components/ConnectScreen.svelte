<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, BrandLogo, Button, TextInput } from "@rekord/ui";
  import type { Account } from "../lib/account";
  import { probeHub, type ProbeFailure } from "../lib/connect.svelte";
  import {
    DEFAULT_HUB_PORT,
    formatHubLabel,
    guessHubMode,
    hubBaseFromParts,
    hubBaseFromQr,
    parseHubAddress,
  } from "../lib/hubAddress";
  import { i18n, t, type AppLocale } from "../lib/i18n.svelte";
  import { qrScannerAvailable, scanQrCode } from "../lib/qrScan";

  let {
    savedBase = "",
    dismissible = false,
    onconnected,
    ondismiss,
  }: {
    /** Indirizzo dell'ultima connessione: si ripropone nei campi. */
    savedBase?: string;
    /** Riaperta dalle impostazioni, con l'app dietro: si puo' tornare indietro. */
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
  });

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
      error = describeFailure(probe);
      return;
    }
    connectedBase = base;
    accounts = probe.accounts;
    defaultAccountId = probe.defaultAccountId;
    step = "accounts";
    // Un hub con un solo profilo non e' una scelta: si entra e si guarda la libreria.
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
    const base = hubBaseFromQr(outcome.text);
    if (!base) {
      error = t("connect.errQrNotHub");
      return;
    }
    applySaved(base);
    // Il QR e' stato inquadrato per collegarsi, non per riempire un campo.
    await connect();
  }

  function setLocale(next: AppLocale) {
    i18n.setLocale(next);
  }

  function initial(name: string): string {
    return (name.trim()[0] || "?").toUpperCase();
  }
</script>

<div class="connect">
  <div class="connect__lang" role="group" aria-label={t("settings.language")}>
    <div class="segmented segmented--joined">
      <button
        type="button"
        class:is-on={i18n.locale === "en"}
        aria-pressed={i18n.locale === "en"}
        onclick={() => setLocale("en")}>EN</button
      >
      <button
        type="button"
        class:is-on={i18n.locale === "it"}
        aria-pressed={i18n.locale === "it"}
        onclick={() => setLocale("it")}>IT</button
      >
    </div>
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
            <div
              class="segmented segmented--joined connect__seg"
              role="group"
              aria-labelledby="connect-mode-label"
            >
              <button
                type="button"
                class:is-on={mode === "local"}
                aria-pressed={mode === "local"}
                onclick={() => {
                  mode = "local";
                  error = "";
                }}>{t("connect.modeLocal")}</button
              >
              <button
                type="button"
                class:is-on={mode === "public"}
                aria-pressed={mode === "public"}
                onclick={() => {
                  mode = "public";
                  error = "";
                }}>{t("connect.modePublic")}</button
              >
            </div>
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
                placeholder="https://nome.trycloudflare.com"
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
            <button
              type="button"
              class="connect__account"
              class:is-opening={openingId === account.id}
              disabled={Boolean(openingId)}
              onclick={() => enter(account.id)}
            >
              <span class="connect__avatar" aria-hidden="true">{initial(account.name)}</span>
              <span class="connect__account-text">
                <span class="connect__account-name">{account.name}</span>
                {#if account.id === defaultAccountId}
                  <span class="connect__badge">{t("connect.defaultAccount")}</span>
                {/if}
              </span>
              <span class="connect__chevron" aria-hidden="true">›</span>
            </button>
          {/each}
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
            <Button class="connect__cta" variant="ghost" onclick={ondismiss}>
              {t("connect.cancel")}
            </Button>
          {/if}
        {:else}
          <Button
            class="connect__cta"
            variant="ghost"
            disabled={Boolean(openingId)}
            onclick={backToAddress}
          >
            {t("connect.changeHub")}
          </Button>
        {/if}
      </div>
    </section>
  </main>
</div>

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
    justify-content: flex-end;
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
    /* La lista degli account e' piu' larga dei due campi dell'indirizzo. */
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

  .connect__seg {
    flex-wrap: nowrap;
  }

  .connect__seg button {
    flex: 1 1 0;
    min-width: 0;
    /* Primo avvio col dito su un telefono: i due modi sono bersagli, non etichette. */
    min-height: var(--rk-tap-min);
  }

  .connect__hostrow {
    display: grid;
    /* L'IP prende quel che resta, la porta quattro cifre e basta. */
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

  .connect__badge {
    justify-self: start;
    font-size: var(--rk-fs-3xs);
    font-weight: 750;
    letter-spacing: 0.04em;
    text-transform: uppercase;
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

  /* I bottoni della procedura sono a tutta riga: qui c'e' una cosa da fare per
     schermata, e sul telefono la riga e' il bersaglio piu' facile da prendere. */
  .connect__actions :global(.connect__cta) {
    width: 100%;
    min-height: var(--rk-tap-min);
  }

  @media (max-width: 559.98px) {
    .connect__card {
      padding: var(--rk-space-xl);
    }

    .connect__shell {
      /* Sul telefono la scheda occupa la larghezza: centrarla in 390px lascerebbe
         due margini e un campo dell'indirizzo stretto. */
      align-items: flex-start;
      padding-top: var(--rk-space-xl);
    }
  }
</style>
