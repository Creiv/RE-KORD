<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, Button, Panel, TextInput } from "@rekord/ui";
  import {
    checkAccessKey,
    isWellFormedAccessKey,
    MIN_ACCESS_KEY_LEN,
    setAccessKey,
    type AccessKeyReason,
  } from "../lib/accessKey";
  import { t } from "../lib/i18n.svelte";

  let {
    reason = "required",
    retryAfter = null,
    onaccepted,
  }: {
    /** Why the prompt is shown: no key yet, a wrong one, or too many wrong ones. */
    reason?: AccessKeyReason;
    retryAfter?: number | null;
    /** The key was accepted and stored (or the hub needs none). */
    onaccepted: () => void;
  } = $props();

  let key = $state("");
  let reveal = $state(false);
  let busy = $state(false);
  let error = $state("");

  function lockedText(seconds: number | null | undefined): string {
    return seconds ? t("accessKey.errLockedFor", { seconds }) : t("accessKey.errLocked");
  }

  onMount(() => {
    if (reason === "invalid") error = t("accessKey.errStoredInvalid");
    else if (reason === "locked") error = lockedText(retryAfter);
  });

  async function submit(event: Event) {
    event.preventDefault();
    error = "";
    // Pasted keys often carry a stray space or line break: the hub never has them.
    const candidate = key.trim();
    if (!isWellFormedAccessKey(candidate)) {
      error = t("accessKey.errFormat", { min: MIN_ACCESS_KEY_LEN });
      return;
    }
    busy = true;
    const result = await checkAccessKey(candidate);
    busy = false;
    if (!result.ok) {
      if (result.reason === "invalid") error = t("accessKey.errInvalid");
      else if (result.reason === "locked") error = lockedText(result.retryAfter);
      else if (result.reason === "not-hub") error = t("accessKey.errNotHub");
      else error = t("accessKey.errUnreachable");
      return;
    }
    if (result.required) setAccessKey(candidate);
    key = "";
    onaccepted();
  }
</script>

<Panel title={t("accessKey.title")}>
  <form class="form" onsubmit={(e) => void submit(e)}>
    <p class="lead">{t("accessKey.lead")}</p>
    <div class="field">
      <label class="label" for="rk-admin-access-key">{t("accessKey.label")}</label>
      <span class="row">
        <TextInput
          id="rk-admin-access-key"
          class="key"
          bind:value={key}
          type={reveal ? "text" : "password"}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          aria-invalid={error ? "true" : undefined}
          oninput={() => (error = "")}
        />
        <Button
          variant="secondary"
          aria-pressed={reveal}
          aria-controls="rk-admin-access-key"
          aria-label={reveal ? t("accessKey.hideAria") : t("accessKey.showAria")}
          onclick={() => (reveal = !reveal)}
        >
          {reveal ? t("accessKey.hide") : t("accessKey.show")}
        </Button>
      </span>
    </div>
    <p class="hint">{t("accessKey.hint")}</p>
    {#if error}
      <div role="alert">
        <Banner tone="error">{error}</Banner>
      </div>
    {/if}
    <div>
      <Button type="submit" disabled={busy || !key.trim()} aria-busy={busy}>
        {busy ? t("accessKey.checking") : t("accessKey.submit")}
      </Button>
    </div>
  </form>
</Panel>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 34rem;
  }

  .lead,
  .hint {
    margin: 0;
    color: var(--rk-muted);
    line-height: var(--rk-lh);
  }

  .hint {
    font-size: var(--rk-fs-xs);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .label {
    font-weight: 600;
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .row :global(.key) {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--rk-mono, monospace);
  }
</style>
