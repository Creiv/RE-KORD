<script lang="ts">
  import { CoverArt } from "@rekord/ui";
  import MetaBadgeCluster from "./MetaBadgeCluster.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import { initials } from "../lib/initials";
  import { previewGenre } from "../lib/trackMoods";

  let {
    kind = "artist" as "artist" | "album",
    title,
    subtitle = "",
    metaLine = "",
    coverSrc = "",
    coverSeed = "",
    favoriteCount = 0,
    albumsMissingMetaCount = 0,
    tracksMissingMetaCount = 0,
    albumExcluded = false,
    albumsExcludedCount = 0,
    tracksExcludedCount = 0,
    loose = false,
    showInitialsFallback = true,
    onclick,
  }: {
    kind?: "artist" | "album";
    title: string;
    subtitle?: string;
    metaLine?: string;
    coverSrc?: string;
    coverSeed?: string;
    favoriteCount?: number;
    albumsMissingMetaCount?: number;
    tracksMissingMetaCount?: number;
    albumExcluded?: boolean;
    albumsExcludedCount?: number;
    tracksExcludedCount?: number;
    loose?: boolean;
    showInitialsFallback?: boolean;
    onclick?: () => void;
  } = $props();

  const metaSeed = $derived(coverSeed || (subtitle ? `${subtitle}/${title}` : title));
  const albumMetaMissing = $derived(
    kind === "album" ? !previewGenre(metaSeed) : false,
  );
  const badge = $derived(initials(title) || title.charAt(0).toUpperCase());
  const useBadge = $derived(kind === "artist" && showInitialsFallback && !coverSrc);
</script>

<button
  type="button"
  class="library-list-tile"
  class:library-list-tile--artist={kind === "artist"}
  class:library-list-tile--album={kind === "album"}
  {onclick}
>
  {#if kind === "artist"}
    <div class="library-list-tile__media">
      {#if useBadge}
        <div class="library-list-tile__badge">{badge}</div>
      {:else}
        <CoverArt {title} src={coverSrc} seed={coverSeed || title} size="tile" />
      {/if}
    </div>
  {:else}
    <div class="library-list-tile__album-wrap">
      <CoverArt {title} src={coverSrc} seed={coverSeed || title} size="tile" />
    </div>
  {/if}

  <div class="library-list-tile__body">
    <div class="library-list-tile__title-row">
      <UiIcon name={kind === "artist" ? "person" : "album"} class="library-list-tile__kind-ic" />
      <div class="library-list-tile__title">{title}</div>
    </div>
    {#if subtitle}
      <div class="library-list-tile__meta">{subtitle}</div>
    {/if}
    {#if metaLine}
      <div class="library-list-tile__tracks-meta">
        <UiIcon name="queueMusic" />
        <span>{metaLine}</span>
      </div>
    {/if}
    <MetaBadgeCluster
      variant="foot"
      missingMeta={albumMetaMissing}
      {albumsMissingMetaCount}
      {tracksMissingMetaCount}
      {favoriteCount}
      {albumExcluded}
      {albumsExcludedCount}
      {tracksExcludedCount}
      {loose}
    />
  </div>
</button>
