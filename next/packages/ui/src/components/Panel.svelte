<script lang="ts">
  let {
    title = "",
    class: className = "",
    children,
    actions,
  }: {
    title?: string;
    class?: string;
    children: import("svelte").Snippet;
    /** Optional controls aligned to the right of the panel title. */
    actions?: import("svelte").Snippet;
  } = $props();
</script>

<section class="rk-panel {className}">
  {#if title || actions}
    <div class="rk-panel__head">
      {#if title}
        <h2 class="rk-panel__title">{title}</h2>
      {/if}
      {#if actions}
        <div class="rk-panel__actions">{@render actions()}</div>
      {/if}
    </div>
  {/if}
  {@render children()}
</section>

<style>
  .rk-panel {
    background: var(--rk-surface-2);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    padding: 0.85rem 1rem 0.95rem;
    margin-bottom: 0;
    box-shadow: var(--rk-shadow);
  }

  .rk-panel__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0 0 0.85rem;
    padding: 0 0 0.65rem;
    border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 88%, transparent);
    min-width: 0;
  }

  .rk-panel__title {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin: 0;
    min-width: 0;
    font-size: var(--rk-fs-subtitle);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: var(--rk-lh-tight);
    color: var(--rk-ink);
  }

  .rk-panel__title::before {
    content: "";
    flex: 0 0 auto;
    width: 3px;
    height: 1.05em;
    border-radius: var(--rk-radius-xs);
    background: linear-gradient(
      180deg,
      var(--rk-accent) 0%,
      color-mix(in srgb, var(--rk-accent-2) 82%, var(--rk-accent) 18%) 100%
    );
  }

  .rk-panel__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.4rem;
    flex: 0 0 auto;
  }
</style>
