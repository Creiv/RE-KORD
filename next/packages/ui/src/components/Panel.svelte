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
    <h2>{title}</h2>
  {/if}
  {@render children()}
</section>

<style>
  .rk-panel {
    background: var(--rk-surface-2);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    padding: 0.75rem 0.9rem 0.85rem;
    margin-bottom: 0;
    box-shadow: var(--rk-shadow);
  }

  h2 {
    margin: 0 0 0.55rem;
    font-size: 0.92rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
</style>
