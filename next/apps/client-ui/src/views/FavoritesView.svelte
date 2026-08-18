<script lang="ts">
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { t } from "../lib/i18n.svelte";
  import { session } from "../lib/session.svelte";
</script>

<div class="view-page view-page--split collection-page">
  <PageToolbar
    eyebrow={t("page.favorites.eyebrow")}
    title={t("page.favorites.title", { count: session.favorites.length })}
  >
    {#snippet icon()}
      <UiIcon name="favorite" class="section-head__ic" />
    {/snippet}
    {#snippet tools()}
      {#if session.favorites.length > 0}
        <PlayCollectionButton
          label={t("page.favorites.play")}
          onclick={() => session.playPoolShuffle(session.favorites)}
        />
      {/if}
    {/snippet}
  </PageToolbar>

  <section class="rk-surface-card collection-page__list view-page__body">
    <TrackList
      tracks={session.favorites}
      favoriteIds={session.favoriteIds}
      playlistOptions={session.playlistOptions}
      activeTrackId={session.current?.id ?? null}
      emptyMessage="Nessun elemento disponibile."
      onplay={(track, list) => session.playCollectionShuffle(track, list)}
      ontoggleFavorite={(track) => void session.toggleFavorite(track)}
      onaddToPlaylist={(playlistId, track) =>
        void session.addToPlaylist(playlistId, track.id)}
    />
  </section>
</div>
