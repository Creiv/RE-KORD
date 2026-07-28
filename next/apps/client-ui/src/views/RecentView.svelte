<script lang="ts">
  import { onMount } from "svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import type { Track } from "../lib/api";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";

  let tracks = $state<Track[]>([]);
  let loading = $state(true);

  function resolveRecent(): Track[] {
    const paths = player.recentRelPaths();
    const byPath = new Map<string, Track>();
    for (const t of session.catalogTracks) byPath.set(t.rel_path, t);
    for (const t of session.favorites) byPath.set(t.rel_path, t);
    for (const t of session.queue) byPath.set(t.rel_path, t);
    for (const t of session.tracks) byPath.set(t.rel_path, t);

    const resolved: Track[] = [];
    for (const path of paths) {
      const t = byPath.get(path);
      if (t) resolved.push(t);
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
  <header class="view-page__toolbar-band">
    <section class="rk-surface-card surface-card--toolbar-only">
      <div class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Cronologia" title="Ascolti recenti">
          <UiIcon name="history" class="section-head__ic" />
        </SectionHeadLead>
        {#if tracks.length > 0}
          <div class="section-head__tools">
            <PlayCollectionButton
              label="Riproduci recenti"
              onclick={() => session.playShuffled(tracks)}
            />
          </div>
        {/if}
      </div>
    </section>
  </header>

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
        onplay={(track, list) => session.playTrack(track, list)}
        ontoggleFavorite={(track) => void session.toggleFavorite(track)}
        onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
      />
    {/if}
  </section>
</div>
