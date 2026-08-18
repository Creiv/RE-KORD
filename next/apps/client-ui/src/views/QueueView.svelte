<script lang="ts">
  import PageToolbar from "../components/PageToolbar.svelte";
  import TrackRow from "../components/TrackRow.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { dragReorder } from "../lib/dragReorder";
  import { t } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import {
    virtualList,
    type VirtualListApi,
    type VirtualWindow,
  } from "../lib/virtualList";

  const VIRTUAL_FROM = 40;

  /** First window before the action measures anything: about one viewport. */
  let win = $state<VirtualWindow>({
    start: 0,
    end: VIRTUAL_FROM,
    padTop: 0,
    padBottom: 0,
    rowPx: 0,
  });
  let dragging = $state(false);
  let rowsApi: VirtualListApi | null = null;

  const virtualized = $derived(session.queue.length >= VIRTUAL_FROM);
  const windowQueue = $derived(
    virtualized ? session.queue.slice(win.start, win.end) : session.queue,
  );
  const currentOffscreen = $derived(
    virtualized &&
      session.currentIndex >= 0 &&
      (session.currentIndex < win.start || session.currentIndex >= win.end),
  );
</script>

<div class="view-page view-page--split queue-page">
  <PageToolbar
    eyebrow={t("page.queue.eyebrow")}
    title={t("page.queue.title", { count: session.queue.length })}
  >
    {#snippet icon()}
      <UiIcon name="list" class="section-head__ic" />
    {/snippet}
    {#snippet tools()}
      {#if currentOffscreen}
        <button
          type="button"
          class="ghost-btn ghost-btn--sm"
          onclick={() => rowsApi?.scrollToIndex(session.currentIndex)}
        >
          {t("page.queue.goToCurrent")}
        </button>
      {/if}
      <input
        class="ghost-input queue-name-input"
        bind:value={session.queuePlaylistName}
        placeholder={t("page.queue.namePlaceholder")}
        aria-label={t("page.queue.namePlaceholder")}
      />
      <button
        type="button"
        class="primary-btn"
        disabled={!session.queue.length}
        onclick={() => void session.saveQueueAsPlaylist()}
      >
        {t("page.queue.save")}
      </button>
      <button
        type="button"
        class="ghost-btn danger"
        disabled={!session.queue.length}
        onclick={() => player.clearQueue()}
      >
        {t("page.queue.clear")}
      </button>
    {/snippet}
  </PageToolbar>

  <section class="rk-surface-card queue-page__list view-page__body">
    {#if session.queue.length === 0}
      <p class="panel-empty">{t("page.queue.empty")}</p>
    {:else}
      <ul
        class="list"
        style:padding-top={virtualized ? `${win.padTop}px` : null}
        style:padding-bottom={virtualized ? `${win.padBottom}px` : null}
        use:dragReorder={{
          onmove: (from, to) => player.moveQueueItem(from, to),
          enabled: session.queue.length > 1,
          ondragstate: (active) => (dragging = active),
        }}
        use:virtualList={{
          count: session.queue.length,
          threshold: VIRTUAL_FROM,
          frozen: dragging,
          onwindow: (next) => (win = next),
          onready: (api) => (rowsApi = api),
        }}
      >
        {#each windowQueue as track, offset (track.id + "-" + (virtualized ? win.start + offset : offset))}
          {@const index = virtualized ? win.start + offset : offset}
          <TrackRow
            {track}
            {index}
            reorderIndex={index}
            autoFocusActive={!virtualized}
            onreorderStep={(delta) =>
              player.moveQueueItem(
                index,
                Math.max(0, Math.min(session.queue.length - 1, index + delta)),
              )}
            revision={session.tick}
            favorited={session.favoriteIds.has(track.id)}
            active={index === session.currentIndex}
            playlistOptions={session.playlistOptions}
            onplay={() => session.playQueueIndex(index)}
            ontoggleFavorite={() => void session.toggleFavorite(track)}
            onaddToPlaylist={(playlistId) => void session.addToPlaylist(playlistId, track.id)}
            onremoveFromQueue={() => player.removeFromQueue(index)}
            ontoggleExclude={() => player.toggleExcludeTrack(track)}
            onremove={() => player.removeFromQueue(index)}
          />
        {/each}
      </ul>
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
    gap: var(--rk-space-lg);
  }
</style>
