<script lang="ts">
  import CoverArt from "./CoverArt.svelte";

  let {
    title,
    subtitle = "",
    coverSrc = "",
    coverSeed = "",
    onclick,
  }: {
    title: string;
    subtitle?: string;
    coverSrc?: string;
    coverSeed?: string;
    onclick?: () => void;
  } = $props();
</script>

<button class="rk-list-tile" type="button" {onclick}>
  <span class="media">
    <CoverArt {title} src={coverSrc} seed={coverSeed || title} size="tile" />
  </span>
  <span class="body">
    <span class="title">{title}</span>
    {#if subtitle}
      <span class="meta">{subtitle}</span>
    {/if}
  </span>
</button>

<style>
  .rk-list-tile {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.95rem;
    width: 100%;
    padding: 0.55rem 0.75rem;
    min-height: 5.1rem;
    text-align: left;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .rk-list-tile:hover {
    border-color: var(--rk-line-strong);
    background: color-mix(in srgb, var(--rk-surface-3) 80%, var(--rk-surface-2));
  }

  .media {
    flex-shrink: 0;
    width: 4.55rem;
    height: 4.55rem;
  }

  .body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
  }

  .title {
    font-weight: 700;
    font-size: var(--rk-fs-md);
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    font-size: var(--rk-fs-xs);
    color: color-mix(in srgb, var(--rk-muted) 88%, var(--rk-ink) 12%);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
