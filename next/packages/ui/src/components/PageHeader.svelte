<script lang="ts">
  import BrandMark from "./BrandMark.svelte";

  let {
    eyebrow = "",
    title = "RE-KORD",
    lede = "",
  }: {
    eyebrow?: string;
    title?: string;
    lede?: string;
  } = $props();
</script>

<header class="rk-page-header">
  <BrandMark {eyebrow} {title} size="lg" />
  {#if lede}
    <p class="lede">{lede}</p>
  {/if}
</header>

<style>
  .rk-page-header {
    margin-bottom: 2rem;
  }

  .lede {
    margin: 0.55rem 0 0;
    color: var(--rk-muted);
    max-width: 36ch;
  }
</style>
