<script lang="ts">
  import { type SelectOption } from "@rekord/ui";
  import type { Track } from "../lib/api";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import TrackRow from "./TrackRow.svelte";

  const DEFAULT_PAGE = 40;

  let {
    tracks = [],
    favoriteIds = new Set<number>(),
    playlistOptions = [],
    activeTrackId = null as number | null,
    emptyMessage = "Nessun brano",
    showQueueActions = true,
    showExclude = true,
    pageSize = DEFAULT_PAGE,
    onplay,
    ontoggleFavorite,
    onaddToPlaylist,
    onremove,
    onedit,
  }: {
    tracks?: Track[];
    favoriteIds?: Set<number>;
    playlistOptions?: SelectOption[];
    activeTrackId?: number | null;
    emptyMessage?: string;
    showQueueActions?: boolean;
    showExclude?: boolean;
    /** Rows rendered per “page”; 0 = no pagination. */
    pageSize?: number;
    onplay: (track: Track, list: Track[]) => void;
    ontoggleFavorite: (track: Track) => void;
    onaddToPlaylist?: (playlistId: string, track: Track) => void;
    onremove?: (track: Track) => void;
    onedit?: (track: Track) => void;
  } = $props();

  let visibleCount = $state(DEFAULT_PAGE);

  $effect(() => {
    // Reset window when the list identity/length changes.
    tracks.length;
    visibleCount = pageSize > 0 ? pageSize : tracks.length;
  });

  const visibleTracks = $derived(
    pageSize > 0 ? tracks.slice(0, visibleCount) : tracks,
  );
  const remaining = $derived(Math.max(0, tracks.length - visibleTracks.length));

  function showMore() {
    if (pageSize <= 0) return;
    visibleCount = Math.min(tracks.length, visibleCount + pageSize);
  }
</script>

{#if tracks.length === 0}
  <p class="panel-empty">{emptyMessage}</p>
{:else}
  <ul class="list">
    {#each visibleTracks as track, i (track.id + "-" + i)}
      <TrackRow
        {track}
        index={i}
        revision={session.tick}
        favorited={favoriteIds.has(track.id)}
        active={activeTrackId === track.id || player.current?.id === track.id}
        {playlistOptions}
        onplay={() => onplay(track, tracks)}
        ontoggleFavorite={() => ontoggleFavorite(track)}
        onaddToPlaylist={
          onaddToPlaylist ? (playlistId) => onaddToPlaylist(playlistId, track) : undefined
        }
        onaddToQueue={showQueueActions ? () => player.addToQueue(track) : undefined}
        onremoveFromQueue={
          showQueueActions ? () => player.removeFromQueueById(track.id) : undefined
        }
        ontoggleExclude={showExclude ? () => player.toggleExcludeTrack(track) : undefined}
        onremove={onremove ? () => onremove(track) : undefined}
        onedit={onedit ? () => onedit(track) : () => session.openTrackEdit(track)}
      />
    {/each}
  </ul>
  {#if remaining > 0}
    <div class="list-more">
      <button type="button" class="ghost-btn ghost-btn--sm" onclick={showMore}>
        Mostra altri ({remaining})
      </button>
      <span class="list-more__meta">{visibleTracks.length} / {tracks.length}</span>
    </div>
  {/if}
{/if}

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    /* Parità React: .list-stack { gap: var(--space-4) } = 0.875rem */
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
