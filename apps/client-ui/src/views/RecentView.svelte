<script lang="ts">
  import { onMount } from "svelte";
  import { Button, EmptyState, Skeleton } from "@rekord/ui";
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import type { Track } from "../lib/api";
  import { collectionSubtitle } from "../lib/collectionInfo";
  import { t } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { prefsRevision } from "../lib/prefsRevision.svelte";
  import { session } from "../lib/session.svelte";

  let loading = $state(true);

  /** Recent paths resolved against what the client already holds. */
  const tracks = $derived.by((): Track[] => {
    const paths = prefsRevision.recentRelPaths;
    const byPath = new Map<string, Track>();
    for (const track of session.catalogTracks) byPath.set(track.rel_path, track);
    for (const track of session.favorites) byPath.set(track.rel_path, track);
    const resolved: Track[] = [];
    for (const path of paths) {
      const track = byPath.get(path);
      if (track) resolved.push(track);
    }
    return resolved;
  });
  const subtitle = $derived(tracks.length ? collectionSubtitle(tracks) : "");

  onMount(() => {
    // Never rejects: offline leaves the catalog as it is.
    void session.ensureCatalogTracks().finally(() => (loading = false));
  });
</script>

<div class="view-page view-page--split collection-page">
  <PageToolbar eyebrow={t("page.recent.eyebrow")} title={t("nav.recent")} {subtitle}>
    {#snippet icon()}
      <UiIcon name="history" class="section-head__ic" />
    {/snippet}
    {#snippet tools()}
      {#if tracks.length > 0}
        <PlayCollectionButton
          label={t("page.recent.play")}
          onclick={() => session.playPoolShuffle(tracks)}
        />
        <Button variant="ghost" onclick={() => player.clearRecent()}>
          {t("core.recent.clear")}
        </Button>
      {/if}
    {/snippet}
  </PageToolbar>

  <section class="rk-surface-card collection-page__list view-page__body">
    {#if loading && tracks.length === 0}
      <Skeleton variant="row" count={6} label={t("core.recent.loading")} />
    {:else if tracks.length === 0}
      <EmptyState title={t("core.recent.emptyTitle")} body={t("core.recent.emptyBody")}>
        {#snippet icon()}<UiIcon name="history" />{/snippet}
        {#snippet action()}
          <Button onclick={() => void session.shuffleLibrary()}>
            <UiIcon name="shuffle" />
            {t("core.recent.emptyCta")}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <TrackList
        {tracks}
        favoriteIds={session.favoriteIds}
        playlistOptions={session.playlistOptions}
        activeTrackId={session.current?.id ?? null}
        onplay={(track) => void session.playGlobalRadio(track)}
        ontoggleFavorite={(track) => void session.toggleFavorite(track)}
        onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
      />
    {/if}
  </section>
</div>
