<script lang="ts">
  import { onMount } from "svelte";
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import type { Track } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";

  let tracks = $state<Track[]>([]);
  let loading = $state(true);

  function resolveRecent(): Track[] {
    const paths = player.recentRelPaths();
    const byPath = new Map<string, Track>();
    for (const track of session.catalogTracks) byPath.set(track.rel_path, track);
    for (const track of session.favorites) byPath.set(track.rel_path, track);
    for (const track of session.queue) byPath.set(track.rel_path, track);
    for (const track of session.tracks) byPath.set(track.rel_path, track);

    const resolved: Track[] = [];
    for (const path of paths) {
      const track = byPath.get(path);
      if (track) resolved.push(track);
    }
    return resolved;
  }

  async function loadRecent() {
    loading = true;
    if (!session.catalogTracks.length) {
      try {
        await session.loadCatalogTracks();
      } catch {
        /* offline */
      }
    }
    tracks = resolveRecent();
    loading = false;
  }

  onMount(() => {
    void loadRecent();
    return player.subscribe(() => {
      tracks = resolveRecent();
    });
  });
</script>

<div class="view-page view-page--split collection-page">
  <PageToolbar
    eyebrow={t("page.recent.eyebrow")}
    title={t("page.recent.title", { count: tracks.length })}
  >
    {#snippet icon()}
      <UiIcon name="history" class="section-head__ic" />
    {/snippet}
    {#snippet tools()}
      {#if tracks.length > 0}
        <PlayCollectionButton
          label={t("page.recent.play")}
          onclick={() => session.playPoolShuffle(tracks)}
        />
      {/if}
    {/snippet}
  </PageToolbar>

  <section class="rk-surface-card collection-page__list view-page__body">
    {#if loading}
      <p class="panel-empty">Caricamento ascolti…</p>
    {:else}
      <TrackList
        tracks={tracks}
        favoriteIds={session.favoriteIds}
        playlistOptions={session.playlistOptions}
        activeTrackId={session.current?.id ?? null}
        emptyMessage="Nessun elemento disponibile."
        onplay={(track) => void session.playGlobalRadio(track)}
        ontoggleFavorite={(track) => void session.toggleFavorite(track)}
        onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
      />
    {/if}
  </section>
</div>
