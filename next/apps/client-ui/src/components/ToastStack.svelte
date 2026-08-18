<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
</script>

<!-- Top centre: clears the player dock and the mobile nav at the bottom. -->
<div class="toasts">
  {#each toasts.items as toast (toast.id)}
    <!-- Hovering any toast freezes every countdown: the stack reads as one block. -->
    <div
      class="toast toast--{toast.tone}"
      class:is-busy={toast.busy}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      onpointerenter={() => toasts.pause()}
      onpointerleave={() => toasts.resume()}
    >
      {#if toast.busy}
        <span class="toast__spinner" aria-hidden="true"></span>
      {:else}
        <span class="toast__ic" aria-hidden="true">
          <UiIcon
            name={toast.tone === "error"
              ? "exclude"
              : toast.tone === "ok"
                ? "sparkle"
                : "note"}
          />
        </span>
      {/if}
      <span class="toast__text">
        {toast.message}
        {#if toast.count > 1}
          <span class="toast__count">×{toast.count}</span>
        {/if}
      </span>
      {#if !toast.busy}
        <button
          type="button"
          class="toast__close"
          title={t("toast.dismiss")}
          aria-label={t("toast.dismiss")}
          onclick={() => toasts.dismiss(toast.id)}
        >
          <UiIcon name="close" />
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: var(--rk-z-toast);
    top: calc(env(safe-area-inset-top, 0px) + 0.4rem);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    /* Larghezza al netto della tacca: in orizzontale il toast non ci finisce sotto. */
    width: min(
      30rem,
      calc(
        100vw - 1.5rem - env(safe-area-inset-left, 0px) - env(
            safe-area-inset-right,
            0px
          )
      )
    );
    /* The stack must not steal clicks from the page underneath. */
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
    max-width: 100%;
    padding: 0.5rem 0.6rem 0.5rem 0.7rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background:
      linear-gradient(var(--rk-surface-2), var(--rk-surface-2)),
      var(--rk-bg);
    box-shadow: var(--rk-shadow-2);
    color: var(--rk-ink);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh-snug);
    animation: toast-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .toast--ok {
    border-color: color-mix(in srgb, var(--rk-ok) 45%, var(--rk-line));
  }

  .toast--error {
    border-color: color-mix(in srgb, var(--rk-danger) 50%, var(--rk-line));
  }

  .toast--info {
    border-color: color-mix(in srgb, var(--rk-accent-2) 40%, var(--rk-line));
  }

  .toast__text {
    min-width: 0;
    /* Long hub errors wrap instead of stretching the toast off screen. */
    overflow-wrap: anywhere;
  }

  .toast__count {
    margin-left: 0.3rem;
    padding: 0.02rem 0.3rem;
    border-radius: var(--rk-radius-round);
    background: rgba(255, 255, 255, 0.09);
    color: var(--rk-muted-strong);
    font-size: var(--rk-fs-2xs);
    font-weight: 700;
    white-space: nowrap;
  }

  .toast__ic {
    display: flex;
    align-items: center;
    color: var(--rk-muted);
  }

  .toast--ok .toast__ic {
    color: var(--rk-ok);
  }

  .toast--error .toast__ic {
    color: var(--rk-danger);
  }

  .toast__ic :global(.ui-ic) {
    width: 1rem;
    height: 1rem;
  }

  .toast__spinner {
    width: 0.95rem;
    height: 0.95rem;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--rk-accent) 28%, transparent);
    border-top-color: var(--rk-accent);
    animation: toast-spin 0.75s linear infinite;
  }

  .toast__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    min-height: 1.5rem;
    padding: 0;
    border: none;
    border-radius: var(--rk-radius);
    background: transparent;
    color: var(--rk-muted);
    cursor: pointer;
  }

  .toast__close:hover {
    color: var(--rk-ink);
    background: rgba(255, 255, 255, 0.07);
  }

  .toast__close :global(.ui-ic) {
    width: 0.95rem;
    height: 0.95rem;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }

  @keyframes toast-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }

    .toast__spinner {
      animation-duration: 1.6s;
    }
  }

  @media (max-width: 639.98px) {
    .toast {
      font-size: var(--rk-fs-xs);
    }
  }
</style>
