<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    open = false,
    title = "",
    eyebrow = "",
    lede = "",
    onclose,
    children,
    footer,
  }: {
    open?: boolean;
    title?: string;
    eyebrow?: string;
    /** Optional path / subtitle under the title (meta-edit parity). */
    lede?: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="rk-modal-back"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onclose();
    }}
    onkeydown={onKey}
  >
    <div
      class="rk-modal rk-scroll"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rk-modal-title"
      tabindex="-1"
    >
      <header class="head">
        <div class="titles">
          {#if eyebrow}
            <p class="eyebrow">{eyebrow}</p>
          {/if}
          <h2 id="rk-modal-title">{title}</h2>
          {#if lede}
            <p class="lede">{lede}</p>
          {/if}
        </div>
        <button
          type="button"
          class="close"
          onclick={onclose}
          aria-label="Chiudi"
          title="Chiudi"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
      </header>
      <div class="body">{@render children()}</div>
      {#if footer}
        <footer class="foot">{@render footer()}</footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .rk-modal-back {
    position: fixed;
    inset: 0;
    z-index: var(--rk-z-modal, 120);
    background: rgba(4, 10, 18, 0.72);
    display: grid;
    place-items: center;
    padding: 1rem;
  }

  .rk-modal {
    width: min(28rem, 100%);
    max-height: min(90dvh, 900px);
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--rk-surface);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    box-shadow: var(--rk-shadow);
    outline: none;
  }

  .head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    padding: 0.7rem 0.85rem 0.55rem;
    border-bottom: 1px solid var(--rk-line);
  }

  .titles {
    min-width: 0;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.68rem;
    color: var(--rk-muted);
    font-weight: 650;
  }

  h2 {
    margin: 0.15rem 0 0;
    font-size: 1.05rem;
    line-height: 1.25;
  }

  .lede {
    margin: 0.35rem 0 0;
    font-size: 0.78rem;
    color: var(--rk-muted);
    word-break: break-all;
    font-family: var(--rk-mono);
  }

  .close {
    flex: 0 0 auto;
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--rk-muted);
    cursor: pointer;
    padding: 0;
    border-radius: var(--rk-radius-sm);
  }

  .close:hover {
    color: var(--rk-ink);
    background: var(--rk-surface-3);
  }

  .body {
    padding: 0.7rem 0.85rem;
    display: grid;
    gap: 0.55rem;
  }

  /* Fields già usano margin: annulla lo stacking con il gap del body. */
  .body :global(.rk-field) {
    margin-bottom: 0;
    gap: 0.28rem;
    font-size: 0.86rem;
  }

  .body :global(.rk-input) {
    padding: 0.42rem 0.65rem;
  }

  .foot {
    padding: 0.55rem 0.85rem 0.7rem;
    border-top: 1px solid var(--rk-line);
    display: flex;
    gap: 0.45rem;
    justify-content: flex-end;
    flex-wrap: wrap;
    align-items: center;
  }

  .foot :global(.rk-modal-foot-spacer) {
    flex: 1 1 0.5rem;
    min-width: 0.5rem;
  }
</style>
