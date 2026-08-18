<script lang="ts">
  import { type SelectOption } from "@rekord/ui";
  import type { Track } from "../lib/api";
  import { dragReorder } from "../lib/dragReorder";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import { virtualList, type VirtualWindow } from "../lib/virtualList";
  import TrackRow from "./TrackRow.svelte";

  const VIRTUAL_FROM = 40;

  let {
    tracks = [],
    favoriteIds = new Set<number>(),
    playlistOptions = [],
    activeTrackId = null as number | null,
    emptyMessage = "Nessun brano",
    showQueueActions = true,
    showPlaylistAction = true,
    showExclude = true,
    onplay,
    ontoggleFavorite,
    onaddToPlaylist,
    onremove,
    onedit,
    onreorder,
  }: {
    tracks?: Track[];
    favoriteIds?: Set<number>;
    playlistOptions?: SelectOption[];
    activeTrackId?: number | null;
    emptyMessage?: string;
    showQueueActions?: boolean;
    showPlaylistAction?: boolean;
    showExclude?: boolean;
    onplay: (track: Track, list: Track[]) => void;
    ontoggleFavorite: (track: Track) => void;
    onaddToPlaylist?: (playlistId: string, track: Track) => void;
    onremove?: (track: Track) => void;
    onedit?: (track: Track) => void;
    /** Enables drag reordering; indexes refer to `tracks`. */
    onreorder?: (from: number, to: number) => void;
  } = $props();

  /** First window before the action measures anything: about one viewport. */
  let win = $state<VirtualWindow>({
    start: 0,
    end: VIRTUAL_FROM,
    padTop: 0,
    padBottom: 0,
    rowPx: 0,
  });
  /** Rows are recycled on scroll, so the virtualizer stands still while dragging. */
  let dragging = $state(false);

  const virtualized = $derived(tracks.length >= VIRTUAL_FROM);
  const windowTracks = $derived(
    virtualized ? tracks.slice(win.start, win.end) : tracks,
  );
</script>

{#if tracks.length === 0}
  <p class="panel-empty">{emptyMessage}</p>
{:else}
  <ul
    class="list"
    style:padding-top={virtualized ? `${win.padTop}px` : null}
    style:padding-bottom={virtualized ? `${win.padBottom}px` : null}
    use:dragReorder={{
      onmove: (from, to) => onreorder?.(from, to),
      enabled: Boolean(onreorder) && tracks.length > 1,
      ondragstate: (active) => (dragging = active),
    }}
    use:virtualList={{
      count: tracks.length,
      threshold: VIRTUAL_FROM,
      frozen: dragging,
      onwindow: (next) => (win = next),
    }}
  >
    {#each windowTracks as track, offset (track.id + "-" + (virtualized ? win.start + offset : offset))}
      {@const i = virtualized ? win.start + offset : offset}
      <TrackRow
        {track}
        index={i}
        reorderIndex={onreorder ? i : null}
        onreorderStep={
          onreorder
            ? (delta) =>
                onreorder(i, Math.max(0, Math.min(tracks.length - 1, i + delta)))
            : undefined
        }
        autoFocusActive={!virtualized}
        revision={session.tick}
        favorited={favoriteIds.has(track.id)}
        active={activeTrackId === track.id || player.current?.id === track.id}
        {playlistOptions}
        {showQueueActions}
        {showPlaylistAction}
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
{/if}

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    /* Parità React: .list-stack { gap: var(--space-4) } = 0.875rem */
    gap: var(--rk-space-lg);
  }
</style>
