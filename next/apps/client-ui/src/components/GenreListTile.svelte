<script lang="ts">
  import MetaBadgeCluster from "./MetaBadgeCluster.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import { previewMoods } from "../lib/trackMoods";

  let {
    title,
    albumCount = 0,
    trackCount = 0,
    coverSlots = [] as string[],
    onclick,
  }: {
    title: string;
    albumCount?: number;
    trackCount?: number;
    coverSlots?: string[];
    onclick?: () => void;
  } = $props();

  const slots = $derived([...coverSlots, "", "", "", ""].slice(0, 4));
  const moods = $derived(previewMoods(title));
</script>

<button class="tile" type="button" {onclick}>
  <span class="quad" aria-hidden="true">
    {#each slots as src}
      <span class="slot" class:empty={!src}>
        {#if src}
          <img {src} alt="" />
        {/if}
      </span>
    {/each}
  </span>
  <span class="body">
    <span class="title-row">
      <UiIcon name="style" class="kind" />
      <span class="title">{title}</span>
    </span>
    <span class="sub">{albumCount} album · {trackCount} brani</span>
    <MetaBadgeCluster missingMeta={moods.length === 0} {moods} variant="inline" />
  </span>
</button>

<style>
  .tile {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.95rem;
    width: 100%;
    min-height: 5.1rem;
    padding: 0.55rem 0.75rem;
    box-sizing: border-box;
    text-align: left;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .tile:hover {
    border-color: var(--rk-line-strong);
    background: color-mix(in srgb, var(--rk-surface-3) 55%, var(--rk-surface-2));
  }

  .quad {
    flex-shrink: 0;
    width: 4.55rem;
    height: 4.55rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 2px;
    padding: 3px;
    border-radius: var(--rk-radius-cover);
    border: 1px solid var(--rk-line);
    overflow: hidden;
    background: var(--rk-surface-3);
    box-sizing: border-box;
  }

  .slot {
    min-width: 0;
    min-height: 0;
    background: color-mix(in srgb, var(--rk-surface) 70%, var(--rk-surface-3));
  }

  .slot.empty {
    background: color-mix(in srgb, var(--rk-line) 35%, var(--rk-surface-3));
  }

  .slot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .title-row :global(.kind) {
    width: 1.1rem;
    height: 1.1rem;
    color: color-mix(in srgb, var(--rk-accent-2) 58%, var(--rk-accent) 42%);
    opacity: 0.88;
    flex-shrink: 0;
  }

  .title {
    font-weight: 700;
    font-size: 0.9rem;
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub {
    font-size: 0.78rem;
    color: color-mix(in srgb, var(--rk-muted) 88%, var(--rk-ink) 12%);
  }
</style>
