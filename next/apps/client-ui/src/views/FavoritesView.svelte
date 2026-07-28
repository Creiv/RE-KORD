<script lang="ts">
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { session } from "../lib/session.svelte";
</script>

<div class="view-page view-page--split collection-page">
  <header class="view-page__toolbar-band">
    <section class="rk-surface-card surface-card--toolbar-only">
      <div class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Raccolta personale" title="Preferiti">
          <UiIcon name="favorite" class="section-head__ic" />
        </SectionHeadLead>
        {#if session.favorites.length > 0}
          <div class="section-head__tools">
            <PlayCollectionButton
              label="Riproduci preferiti"
              onclick={() => session.playShuffled(session.favorites)}
            />
          </div>
        {/if}
      </div>
    </section>
  </header>

  <section class="rk-surface-card collection-page__list view-page__body">
    <TrackList
      tracks={session.favorites}
      favoriteIds={session.favoriteIds}
      playlistOptions={session.playlistOptions}
      activeTrackId={session.current?.id ?? null}
      emptyMessage="Nessun elemento disponibile."
      onplay={(track, list) => session.playShuffled(list, track)}
      ontoggleFavorite={(track) => void session.toggleFavorite(track)}
      onaddToPlaylist={(playlistId, track) =>
        void session.addToPlaylist(playlistId, track.id)}
    />
  </section>
</div>
