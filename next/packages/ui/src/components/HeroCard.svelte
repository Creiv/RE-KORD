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
    /* Ultimo layer = bg: opaco anche se --rk-surface-2 è rgba. */
    background:
      radial-gradient(ellipse at 12% 20%, var(--rk-page-glow-1), transparent 55%),
      radial-gradient(ellipse at 88% 0%, var(--rk-page-glow-2), transparent 45%),
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--rk-accent) 10%, var(--rk-surface-2)),
        var(--rk-surface-2) 55%
      ),
      var(--rk-bg);
    box-shadow: var(--rk-shadow);
    margin-bottom: 0;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.68rem;
    font-weight: 700;
    color: color-mix(in srgb, var(--rk-accent-2) 70%, var(--rk-muted) 30%);
    line-height: 1.2;
  }

  h1 {
    margin: 0.1rem 0 0;
    font-size: clamp(1.2rem, 2vw, 1.55rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }

  .actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }
</style>
