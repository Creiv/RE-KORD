<script lang="ts">
  let {
    title = "",
    class: className = "",
    children,
  }: {
    title?: string;
    class?: string;
    children: import("svelte").Snippet;
  } = $props();
</script>

<section class="rk-panel {className}">
  {#if title}
    <h2 class="rk-panel__title">{title}</h2>
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

  .rk-panel__title {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin: 0 0 0.85rem;
    padding: 0 0 0.65rem;
    font-size: 1.08rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.2;
    color: var(--rk-ink);
    border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 88%, transparent);
  }

  .rk-panel__title::before {
    content: "";
    flex: 0 0 auto;
    width: 3px;
    height: 1.05em;
    border-radius: 2px;
    background: linear-gradient(
      180deg,
      var(--rk-accent) 0%,
      color-mix(in srgb, var(--rk-accent-2) 82%, var(--rk-accent) 18%) 100%
    );
  }
</style>
