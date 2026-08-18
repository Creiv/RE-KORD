<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    eyebrow = "RE-KORD",
    title,
    children,
  }: {
    eyebrow?: string;
    title: string;
    children?: Snippet;
  } = $props();
</script>

<section class="rk-hero">
  <div class="lead">
    <p class="eyebrow">{eyebrow}</p>
    <h1>{title}</h1>
  </div>
  {#if children}
    <div class="actions">{@render children()}</div>
  {/if}
</section>

<style>
  .rk-hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem 1rem;
    flex-wrap: wrap;
    padding: 0.75rem 0.95rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    /* Stesso composite delle altre schede (Panel / surface-card); banda accent in glass-surfaces.css. */
    background:
      linear-gradient(var(--rk-surface-2), var(--rk-surface-2)),
      var(--rk-bg);
    box-shadow: var(--rk-shadow);
    margin-bottom: 0;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--rk-fs-eyebrow);
    font-weight: 700;
    color: color-mix(in srgb, var(--rk-accent-2) 70%, var(--rk-muted) 30%);
    line-height: var(--rk-lh-tight);
  }

  h1 {
    margin: 0.1rem 0 0;
    font-size: clamp(1.2rem, 2vw, 1.55rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: var(--rk-lh-tight);
  }

  .actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }
</style>
