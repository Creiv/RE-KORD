<script lang="ts">
  let {
    eyebrow = "",
    title = "RE-KORD",
    size = "md",
  }: {
    eyebrow?: string;
    title?: string;
    size?: "sm" | "md" | "lg";
  } = $props();
</script>

<div class="rk-brand {size}">
  {#if eyebrow}
    <p class="eyebrow">{eyebrow}</p>
  {/if}
  <h1>
    <span class="mark">{title}</span>
  </h1>
</div>

<style>
  .rk-brand h1 {
    margin: 0.1rem 0 0;
    font-family: var(--rk-display);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  .mark {
    background: linear-gradient(135deg, var(--rk-ink) 40%, var(--rk-accent-2));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 0.68rem;
    color: var(--rk-muted);
    font-weight: 650;
  }

  .sm h1 {
    font-size: 1.25rem;
  }

  .md h1 {
    font-size: 1.55rem;
  }

  .lg h1 {
    font-size: clamp(2rem, 4.5vw, 2.75rem);
  }
</style>
