<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Banner, BrandLogo, Button, Segmented, TextInput } from "@rekord/ui";
  import {
    checkAccessKey,
    clearAccessKeyRefusal,
    initialAccessKeyMessage,
    isWellFormedAccessKey,
    MIN_ACCESS_KEY_LEN,
    setAccessKey,
    type AccessKeyMessage,
    type AccessKeyReason,
  } from "../lib/accessKey";
  import { formatHubLabel } from "../lib/hubAddress";
  import { hubModules } from "../lib/hubModules.svelte";
  import { i18n, t } from "../lib/i18n.svelte";
  import { compat } from "../lib/platform/compatState.svelte";
  import { normalizeLocale } from "../lib/userPrefs";

  let {
    base = "",
    reason = "required",
    noticeKey = "",
    onaccepted,
    oncancel,
    cancelLabel,
  }: {
    /** Hub asking for the key; empty = the hub serving this page. */
    base?: string;
    /** Why we are here: no key yet, a wrong one, or too many wrong ones. */
    reason?: AccessKeyReason;
    /** Table key of a message to show on arrival instead of the one `reason` implies. */
    noticeKey?: string;
    /** The key was accepted and stored. */
    onaccepted: () => void;
    /** Leave without a new key (connection flow, settings). */
    oncancel?: () => void;
    /** Label of the way back; «‹ Change hub» by default. */
    cancelLabel?: string;
  } = $props();

  /** Lock length when the hub does not say (it sends `Retry-After`). */
  const DEFAULT_LOCK_SECONDS = 60;

  let key = $state("");
  let reveal = $state(false);
  let busy = $state(false);
  let error = $state<AccessKeyMessage | null>(null);
  /** Seconds left of a wrong-key lock: submitting is pointless until 0. */
  let lockLeft = $state(0);
  let lockTimer: ReturnType<typeof setInterval> | null = null;

  const inputId = "rk-access-key";
  const hintId = "rk-access-key-hint";
  const errorId = "rk-access-key-error";

  const hubLabel = $derived(
    formatHubLabel(base || (typeof location === "undefined" ? "" : location.origin)),
  );
  const shownError = $derived(
    lockLeft > 0
      ? t("accessKey.errLockedFor", { seconds: lockLeft })
      : error
        ? t(error.key, error.vars)
        : "",
  );

  onMount(() => {
    error = initialAccessKeyMessage(reason, noticeKey);
    if (!error && reason === "locked") startLock(DEFAULT_LOCK_SECONDS);
    document.getElementById(inputId)?.focus();
  });

  onDestroy(stopLock);

  function stopLock() {
    if (lockTimer != null) clearInterval(lockTimer);
    lockTimer = null;
    lockLeft = 0;
  }

  function startLock(seconds: number) {
    stopLock();
    lockLeft = Math.max(1, Math.round(seconds));
    lockTimer = setInterval(() => {
      lockLeft -= 1;
      if (lockLeft <= 0) {
        stopLock();
        error = null;
        document.getElementById(inputId)?.focus();
      }
    }, 1000);
  }

  async function submit(event?: Event) {
    event?.preventDefault();
    if (busy || lockLeft > 0) return;
    error = null;
    // Pasted keys often carry a stray space or line break: the hub never has them.
    const candidate = key.trim();
    if (!isWellFormedAccessKey(candidate)) {
      error = { key: "accessKey.errFormat", vars: { min: MIN_ACCESS_KEY_LEN } };
      return;
    }
    busy = true;
    const result = await checkAccessKey(base, candidate);
    busy = false;
    if (!result.ok) {
      switch (result.reason) {
        case "invalid":
          error = { key: "accessKey.errInvalid" };
          break;
        case "locked":
          startLock(result.retryAfter ?? DEFAULT_LOCK_SECONDS);
          break;
        case "not-hub":
          error = { key: "accessKey.errNotHub" };
          break;
        default:
          error = { key: "accessKey.errUnreachable" };
      }
      document.getElementById(inputId)?.focus();
      return;
    }
    if (result.required) setAccessKey(base, candidate);
    // Also when the hub no longer asks for a key: calls may go out again.
    clearAccessKeyRefusal(base);
    // The full health only arrives with the key: check compatibility and the
    // hub's modules again with it.
    compat.apply(result.health);
    hubModules.apply(result.health);
    key = "";
    onaccepted();
  }
</script>

<div class="access">
  <div class="access__lang">
    <Segmented
      ariaLabel={t("settings.language")}
      value={i18n.locale}
      onchange={(v) => i18n.setLocale(normalizeLocale(v))}
      options={[
        { value: "it", label: "Italiano" },
        { value: "en", label: "English" },
        { value: "de", label: "Deutsch" },
      ]}
    />
  </div>
  <main class="access__shell">
    <form
      class="access__card rk-surface-card"
      aria-labelledby="rk-access-key-title"
      aria-busy={busy}
      novalidate
      onsubmit={(e) => void submit(e)}
    >
      <header class="access__head">
        <div class="access__brand">
          <BrandLogo size="lg" />
          <p class="access__eyebrow">RE-KORD</p>
        </div>
        <h1 class="access__title" id="rk-access-key-title">{t("accessKey.title")}</h1>
        <p class="access__lead">{t("accessKey.lead", { hub: hubLabel })}</p>
      </header>

      <div class="access__field">
        <label class="access__label" for={inputId}>{t("accessKey.label")}</label>
        <div class="access__row">
          <TextInput
            id={inputId}
            class="access__input"
            bind:value={key}
            type={reveal ? "text" : "password"}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            readonly={busy}
            aria-invalid={shownError ? "true" : undefined}
            aria-describedby={shownError ? `${hintId} ${errorId}` : hintId}
            oninput={() => {
              if (lockLeft <= 0) error = null;
            }}
          />
          <Button
            variant="secondary"
            aria-pressed={reveal}
            aria-controls={inputId}
            aria-label={reveal ? t("accessKey.hideAria") : t("accessKey.showAria")}
            onclick={() => (reveal = !reveal)}
          >
            {reveal ? t("accessKey.hide") : t("accessKey.show")}
          </Button>
        </div>
        <p class="access__hint" id={hintId}>{t("accessKey.hint")}</p>
      </div>

      <div class="access__error" id={errorId} role="alert" aria-live="assertive">
        {#if shownError}
          <Banner tone="error">{shownError}</Banner>
        {/if}
      </div>

      <div class="access__actions">
        <Button class="access__cta" type="submit" disabled={busy || lockLeft > 0 || !key.trim()}>
          {busy ? t("accessKey.checking") : t("accessKey.submit")}
        </Button>
        {#if oncancel}
          <Button class="access__quiet" variant="link" disabled={busy} onclick={oncancel}>
            {#if cancelLabel}
              {cancelLabel}
            {:else}
              <span aria-hidden="true">‹</span>
              {t("connect.changeHub")}
            {/if}
          </Button>
        {/if}
      </div>
    </form>
  </main>
</div>

<style>
  .access {
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

  .access__lang {
    display: flex;
    justify-content: flex-end;
    padding: calc(env(safe-area-inset-top, 0px) + var(--rk-space-xl))
      calc(env(safe-area-inset-right, 0px) + var(--rk-space-xl)) 0
      calc(env(safe-area-inset-left, 0px) + var(--rk-space-xl));
  }

  .access__shell {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--rk-space-2xl) calc(env(safe-area-inset-right, 0px) + var(--rk-space-xl))
      calc(env(safe-area-inset-bottom, 0px) + var(--rk-space-2xl))
      calc(env(safe-area-inset-left, 0px) + var(--rk-space-xl));
  }

  .access__card {
    width: 100%;
    max-width: 26rem;
    padding: var(--rk-space-2xl);
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-lg);
  }

  .access__brand {
    display: flex;
    align-items: center;
    gap: var(--rk-space-lg);
  }

  .access__eyebrow {
    margin: 0;
    color: var(--rk-accent-2);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 700;
  }

  .access__title {
    margin: var(--rk-space-lg) 0 var(--rk-space-sm);
  }

  .access__lead,
  .access__hint {
    margin: 0;
    color: var(--rk-muted);
    line-height: var(--rk-lh);
  }

  .access__hint {
    font-size: 0.875em;
  }

  .access__field {
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-sm);
  }

  .access__label {
    font-weight: 600;
  }

  .access__row {
    display: flex;
    gap: var(--rk-space-sm);
  }

  .access__row :global(.access__input) {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--rk-mono, monospace);
  }

  .access__error:empty {
    display: none;
  }

  .access__actions {
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-sm);
  }

  .access__actions :global(.access__cta) {
    width: 100%;
  }
</style>
