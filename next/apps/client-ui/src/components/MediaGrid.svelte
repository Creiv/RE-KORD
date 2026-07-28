<script lang="ts">
  import { EmptyState } from "@rekord/ui";
  import LibraryListTile from "./LibraryListTile.svelte";

  type Item = {
    id: number | string;
    title: string;
    subtitle?: string;
    metaLine?: string;
    coverSrc?: string;
    coverSeed?: string;
    kind?: "artist" | "album";
    favoriteCount?: number;
    albumsMissingMetaCount?: number;
    tracksMissingMetaCount?: number;
    genreMissing?: boolean;
    albumExcluded?: boolean;
    albumsExcludedCount?: number;
    tracksExcludedCount?: number;
    loose?: boolean;
  };

  let {
    items = [],
    emptyMessage = "Nessun elemento",
    kind = "artist" as "artist" | "album",
    dense = true,
    /** Colonne più strette (parity old library-overview-cols--dashboard). */
    dashboard = false,
    onselect,
  }: {
    items?: Item[];
    emptyMessage?: string;
    kind?: "artist" | "album";
    dense?: boolean;
    dashboard?: boolean;
    onselect: (id: number | string) => void;
  } = $props();
</script>

{#if items.length}
  <div class="list" class:list--cols={dense} class:list--dashboard={dashboard}>
    {#each items as item (item.id)}
      <LibraryListTile
        kind={item.kind ?? kind}
        title={item.title}
        subtitle={item.subtitle ?? ""}
        metaLine={item.metaLine ?? ""}
        coverSrc={item.coverSrc ?? ""}
        coverSeed={item.coverSeed ?? item.title}
        favoriteCount={item.favoriteCount ?? 0}
        albumsMissingMetaCount={item.albumsMissingMetaCount ?? 0}
        tracksMissingMetaCount={item.tracksMissingMetaCount ?? 0}
        genreMissing={item.genreMissing ?? false}
        albumExcluded={item.albumExcluded ?? false}
        albumsExcludedCount={item.albumsExcludedCount ?? 0}
        tracksExcludedCount={item.tracksExcludedCount ?? 0}
        loose={item.loose ?? false}
        onclick={() => onselect(item.id)}
      />
    {/each}
  </div>
{:else}
  <EmptyState message={emptyMessage} />
{/if}

<style>
  .list {
    display: grid;
    gap: 0.45rem;
    width: 100%;
  }

  .list > :global(*) {
    min-width: 0;
  }

  .list--cols {
    grid-template-columns: repeat(auto-fill, minmax(min(19rem, 100%), 1fr));
    gap: var(--rk-space-4) var(--rk-space-5);
  }

  .list--cols.list--dashboard {
    grid-template-columns: repeat(auto-fill, minmax(min(17.5rem, 100%), 1fr));
  }
</style>
