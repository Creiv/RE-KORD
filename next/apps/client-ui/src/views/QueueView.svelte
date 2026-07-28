<script lang="ts">
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackRow from "../components/TrackRow.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";

  const PAGE = 40;
  let visibleCount = $state(PAGE);

  $effect(() => {
    session.queue.length;
    visibleCount = PAGE;
  });

  const visibleQueue = $derived(session.queue.slice(0, visibleCount));
  const remaining = $derived(Math.max(0, session.queue.length - visibleQueue.length));

  function showMore() {
    visibleCount = Math.min(session.queue.length, visibleCount + PAGE);
  }
</script>

<div class="view-page view-page--split queue-page">
  <header class="view-page__toolbar-band">
    <section class="rk-surface-card surface-card--toolbar-only">
      <div class="section-head section-head--page-toolbar page-toolbar">
        <SectionHeadLead
          eyebrow="Coda di riproduzione"
          title={`${session.queue.length} brani`}
        >
          <UiIcon name="list" class="section-head__ic" />
        </SectionHeadLead>
        <div class="section-head__tools page-toolbar__actions">
          <div class="hero-card__actions queue-hero-actions">
            <input
              class="ghost-input queue-name-input"
              bind:value={session.queuePlaylistName}
              placeholder="Nome playlist da salvare"
            />
            <button
              type="button"
              class="primary-btn"
              disabled={!session.queue.length}
              onclick={() => void session.saveQueueAsPlaylist()}
            >
              Salva come playlist
            </button>
            <button
              type="button"
              class="ghost-btn danger"
              disabled={!session.queue.length}
              onclick={() => player.clearQueue()}
            >
              Svuota
            </button>
          </div>
        </div>
      </div>
    </section>
  </header>

  <section class="rk-surface-card queue-page__list view-page__body">
    {#if session.queue.length === 0}
      <p class="panel-empty">Nessun brano in coda.</p>
    {:else}
      <ul class="list">
        {#each visibleQueue as track, index (track.id + "-" + index)}
          <TrackRow
            {track}
            {index}
            revision={session.tick}
            favorited={session.favoriteIds.has(track.id)}
            active={index === session.currentIndex}
            playlistOptions={session.playlistOptions}
            onplay={() => session.playTrack(track, session.queue)}
            ontoggleFavorite={() => void session.toggleFavorite(track)}
            onaddToPlaylist={(playlistId) => void session.addToPlaylist(playlistId, track.id)}
            onremoveFromQueue={() => player.removeFromQueue(index)}
            ontoggleExclude={() => player.toggleExcludeTrack(track)}
            onremove={() => player.removeFromQueue(index)}
          >
            {#snippet extraActions()}
              <button
                type="button"
                class="track-row__ic"
                title="Sposta su"
                aria-label="Sposta su"
                onclick={() => player.moveQueueItem(index, Math.max(0, index - 1))}
              >
                <UiIcon name="prev" />
              </button>
              <button
                type="button"
                class="track-row__ic"
                title="Sposta giù"
                aria-label="Sposta giù"
                onclick={() =>
                  player.moveQueueItem(index, Math.min(session.queue.length - 1, index + 1))}
              >
                <UiIcon name="next" />
              </button>
            {/snippet}
          </TrackRow>
        {/each}
      </ul>
      {#if session.currentIndex >= visibleCount}
        <div class="list-more">
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            onclick={() => {
              visibleCount = Math.min(
                session.queue.length,
                Math.ceil((session.currentIndex + 1) / PAGE) * PAGE,
              );
            }}
          >
            Vai al brano corrente
          </button>
        </div>
      {/if}
      {#if remaining > 0}
        <div class="list-more">
          <button type="button" class="ghost-btn ghost-btn--sm" onclick={showMore}>
            Mostra altri ({remaining})
          </button>
          <span class="list-more__meta">{visibleQueue.length} / {session.queue.length}</span>
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-4);
  }

  .list-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 0.85rem 0 0.25rem;
  }

  .list-more__meta {
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rk-muted);
  }
</style>
