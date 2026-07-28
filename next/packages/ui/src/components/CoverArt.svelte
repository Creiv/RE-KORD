<script lang="ts">
  let {
    title = "",
    src = "",
    // Kept for API parity with LibraryListTile / MediaTile callers.
    seed: _seed = "",
    size = "md",
    rounded = true,
  }: {
    title?: string;
    src?: string;
    seed?: string;
    size?: "sm" | "md" | "lg" | "xl" | "tile" | "dock";
    rounded?: boolean;
  } = $props();

  let failed = $state(false);
  const initial = $derived((title.trim().charAt(0) || "♪").toUpperCase());
  const showImage = $derived(Boolean(src) && !failed);

  $effect(() => {
    src;
    failed = false;
  });
</script>

<div class="rk-cover {size}" class:rounded aria-hidden="true">
  {#if showImage}
    <img {src} alt="" loading="lazy" onerror={() => (failed = true)} />
  {:else}
    <span class="glyph">{initial}</span>
  {/if}
</div>

<style>
  .rk-cover {
    position: relative;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
    background: linear-gradient(
      135deg,
      var(--rk-album-fb-1),
      var(--rk-album-fb-2)
    );
    color: var(--rk-ink);
    font-weight: 800;
    font-family: var(--rk-badge-font);
    user-select: none;
    border: 1px solid color-mix(in srgb, var(--rk-accent) 18%, var(--rk-line) 82%);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--rk-bg) 65%, transparent);
  }

  .rk-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .glyph {
    line-height: 1;
  }

  .rounded {
    border-radius: var(--rk-radius-cover);
  }

  .sm {
    width: 40px;
    height: 40px;
    font-size: 0.95rem;
  }

  .md {
    width: 48px;
    height: 48px;
    font-size: 1.1rem;
  }

  .dock {
    width: 58px;
    height: 58px;
    font-size: 1.35rem;
  }

  .tile {
    width: 4.55rem;
    height: 4.55rem;
    font-size: 1.08rem;
  }

  .lg {
    width: 120px;
    height: 120px;
    font-size: 2.4rem;
  }

  .xl {
    width: clamp(140px, 18vw, 200px);
    height: clamp(140px, 18vw, 200px);
    font-size: 3rem;
    box-shadow: var(--rk-shadow-2);
  }
</style>
