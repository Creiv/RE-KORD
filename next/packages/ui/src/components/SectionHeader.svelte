<script lang="ts">
  import Button from "./Button.svelte";

  let {
    title,
    subtitle = "",
    backLabel = "",
    onback,
    children,
  }: {
    title: string;
    subtitle?: string;
    backLabel?: string;
    onback?: () => void;
    children?: import("svelte").Snippet;
  } = $props();
</script>

<header class="rk-section-header">
  <div class="text">
    {#if onback}
      <Button variant="ghost" onclick={onback}>{backLabel || "← Indietro"}</Button>
    {/if}
    <div>
      <h2>{title}</h2>
      {#if subtitle}
        <p>{subtitle}</p>
      {/if}
    </div>
  </div>
  {#if children}
    <div class="actions">{@render children()}</div>
  {/if}
</header>

<style>
  .rk-section-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    margin-bottom: var(--rk-section-gap);
    flex-wrap: wrap;
  }

  .text {
    display: grid;
    gap: 0.55rem;
  }

  h2 {
    margin: 0;
    font-size: 1.22rem;
    font-weight: 800;
    letter-spacing: -0.025em;
  }

  p {
    margin: 0.2rem 0 0;
    color: color-mix(in srgb, var(--rk-accent-2) 45%, var(--rk-muted) 55%);
    font-size: 0.82rem;
    font-weight: 550;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
</style>
