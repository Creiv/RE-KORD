<script lang="ts" module>
  /** Only one popover open across all TrackRows. */
  let dismissActivePopover: (() => void) | null = null;

  function claimTrackRowPopover(dismiss: () => void) {
    if (dismissActivePopover && dismissActivePopover !== dismiss) {
      dismissActivePopover();
    }
    dismissActivePopover = dismiss;
    return () => {
      if (dismissActivePopover === dismiss) dismissActivePopover = null;
    };
  }

</script>

<script lang="ts">
  import { CoverArt, type SelectOption } from "@rekord/ui";
  import { coverUrlFor, type Track } from "../lib/api";
  import { isExternalTrack, isLiveTrack } from "../lib/externalItems";
  import { floating } from "../lib/floatingPopover";
  import { formatTime, player } from "../lib/player";
  import { t, tp } from "../lib/i18n.svelte";
  import { session } from "../lib/session.svelte";
  import { lyricsKind, trackHasFileMeta, type TrackMoodId } from "../lib/trackMoods";
  import { trackRowStats } from "../lib/trackRowStats.svelte";
  import GraphicEq from "./icons/GraphicEq.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import MetaBadgeCluster from "./MetaBadgeCluster.svelte";
  import TrackLyricsIcon from "./TrackLyricsIcon.svelte";

  let {
    track,
    index = 0,
    revision: _revision = 0,
    plays: playsProp,
    moods: moodsProp,
    inQueue: inQueueProp,
    excluded: excludedProp,
    albumLocked: albumLockedProp,
    inAlbum = false,
    coverSrc,
    favorited = false,
    active = false,
    eqLive = true,
    playlistOptions = [],
    /** Like React TrackListRow: queue/playlist always available unless opted out. */
    showQueueActions = true,
    showPlaylistAction = true,
    removeInline = true,
    autoFocusActive = true,
    extraActions = null as import("svelte").Snippet | null,
    reorderIndex = null,
    onreorderStep,
    onplay,
    ontoggleFavorite,
    onaddToPlaylist,
    onaddToQueue,
    onremoveFromQueue,
    ontoggleExclude,
    onremove,
    onedit,
  }: {
    track: Track;
    index?: number;
    /** @deprecated Rows read shared, revision-keyed stats (lib/trackRowStats). Ignored. */
    revision?: number;
    /** Play count (computed once per list by TrackList). Falls back to trackRowStats. */
    plays?: number;
    moods?: TrackMoodId[];
    inQueue?: boolean;
    excluded?: boolean;
    albumLocked?: boolean;
    /** Album context: the meta line leaves out the album name. */
    inAlbum?: boolean;
    /** Cover URL, or null when the hub says there is none. Default: album cover. */
    coverSrc?: string | null;
    favorited?: boolean;
    active?: boolean;
    /**
     * The active row's equalizer may move (one row per list: a track listed
     * twice animates only once). On WebKitGTK it steps once per second of
     * playback, with the rail icon, so it adds no frame of its own.
     */
    eqLive?: boolean;
    playlistOptions?: SelectOption[];
    showQueueActions?: boolean;
    showPlaylistAction?: boolean;
    /** `onremove` also gets the legacy red × among the row actions (playlists). */
    removeInline?: boolean;
    autoFocusActive?: boolean;
    extraActions?: import("svelte").Snippet | null;
    /** Position in the reorderable list; enables the drag grip when set. */
    reorderIndex?: number | null;
    /** Keyboard alternative to dragging: -1 moves up, +1 moves down. */
    onreorderStep?: (delta: number) => void;
    onplay: () => void;
    ontoggleFavorite: () => void;
    onaddToPlaylist?: (playlistId: string) => void;
    onaddToQueue?: () => void;
    onremoveFromQueue?: () => void;
    ontoggleExclude?: () => void;
    onremove?: () => void;
    onedit?: () => void;
  } = $props();

  let rowEl: HTMLLIElement | null = $state(null);
  let overflowEl: HTMLDivElement | null = $state(null);
  let playlistAnchorEl: HTMLDivElement | null = $state(null);
  let menuOpen = $state(false);
  let playlistOpen = $state(false);
  let prevActive = false;

  // Props from the list win; a row rendered on its own reads the same shared,
  // revision-keyed snapshot (never re-parses prefs per row).
  const inQueue = $derived(inQueueProp ?? trackRowStats.inQueue(track.id));
  const excluded = $derived(excludedProp ?? trackRowStats.excluded(track));
  const albumLocked = $derived(albumLockedProp ?? trackRowStats.albumLocked(track));
  const plays = $derived(playsProp ?? trackRowStats.plays(track));
  const moods = $derived(moodsProp ?? trackRowStats.moods(track));
  /** Podcast episode / live stream: no library actions (favourite, playlist, edit, exclude). */
  const external = $derived(isExternalTrack(track));
  /** "Artist · Album"; an episode / live stream shows its show once. */
  const metaText = $derived(
    inAlbum || external ? track.artist_name : `${track.artist_name} · ${track.album_name}`,
  );
  const live = $derived(isLiveTrack(track));
  /** Active row: its EQ moves while playing (`eqLive`), legacy paused pose otherwise. */
  const showStudio = $derived(active);
  const trackLyricsKind = $derived(lyricsKind(track.lyrics));
  const missingMeta = $derived(!trackHasFileMeta(track));
  const coverUrl = $derived(
    coverSrc !== undefined
      ? coverSrc
      : coverUrlFor(track, 128),
  );

  /** Playlist options: explicit prop, otherwise the session catalog (like React). */
  const resolvedPlaylistOptions = $derived(
    playlistOptions.length > 0 ? playlistOptions : session.playlistOptions,
  );

  function addToQueue() {
    if (onaddToQueue) onaddToQueue();
    else player.addToQueue(track);
  }

  function removeFromQueue() {
    if (onremoveFromQueue) onremoveFromQueue();
    else player.removeFromQueueById(track.id);
  }

  /** Legacy: every row can open the track editor, wherever it is listed. */
  function editTrack() {
    if (onedit) onedit();
    else session.openTrackEdit(track);
  }

  function addToPlaylist(playlistId: string) {
    if (onaddToPlaylist) onaddToPlaylist(playlistId);
    else void session.addToPlaylist(playlistId, track.id);
  }

  /*
   * Inline actions vs overflow menu is decided by CSS container queries on the
   * list (`track-row.css`, container `track-list`, 651px): both sets are in the
   * DOM and the hidden one is `display: none`, so it is out of the tab order and
   * the accessibility tree. No per-row width measuring.
   */

  $effect(() => {
    if (!autoFocusActive || !active || !rowEl) {
      prevActive = active;
      return;
    }
    if (prevActive) return;
    prevActive = true;
    const raf = requestAnimationFrame(() => {
      rowEl?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  });

  /** Like old usePopoverLayerAnchored: outside click, Esc, scroll (capture), resize — document-level. */
  $effect(() => {
    if (!menuOpen && !playlistOpen) return;

    const dismiss = () => {
      menuOpen = false;
      playlistOpen = false;
    };
    const releaseExclusive = claimTrackRowPopover(dismiss);

    // Menus are lifted to <body> (use:floating): only one is open at a time.
    const insidePopover = (t: EventTarget | null) => {
      if (!(t instanceof Node)) return false;
      if (overflowEl?.contains(t)) return true;
      if (playlistAnchorEl?.contains(t)) return true;
      const el = t instanceof Element ? t : t.parentElement;
      return Boolean(el?.closest(".track-row__overflow-menu, .track-row__playlist-popover"));
    };

    const onPointerDown = (e: PointerEvent) => {
      if (insidePopover(e.target)) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && insidePopover(t)) return;
      if (
        t instanceof Element &&
        t.closest(".track-row__overflow-menu, .track-row__playlist-popover")
      ) {
        return;
      }
      dismiss();
    };
    const onResize = () => dismiss();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      releaseExclusive();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  });

  function run(fn?: () => void) {
    menuOpen = false;
    playlistOpen = false;
    fn?.();
  }

  function openStudio() {
    session.navigate("studio");
    session.studioPane = "listen";
  }
</script>

<li
  bind:this={rowEl}
  class="track-row"
  class:is-active={active}
  class:is-menu-open={menuOpen || playlistOpen}
  data-reorder-index={reorderIndex ?? undefined}
>
  <div class="track-row__art-wrap">
    <CoverArt kind="track" title={track.title} src={coverUrl} size="md" />
    {#if showStudio}
      <button
        type="button"
        class="track-row__art-studio"
        title={t("player.openListen")}
        aria-label={t("player.openListen")}
        onclick={openStudio}
      >
        <GraphicEq animated={session.playing} live={eqLive} beat={Math.floor(session.currentTime)} />
      </button>
    {:else}
      <button
        type="button"
        class="track-row__art-play"
        title={t("trackRow.play")}
        aria-label={t("trackRow.play")}
        onclick={onplay}
      >
        <UiIcon name="play" />
      </button>
    {/if}
  </div>

  <button type="button" class="track-row__main" onclick={onplay}>
    <span class="track-row__title-row">
      <span class="track-row__title" title={track.title}>{track.title}</span>
      <span class="track-row__stats">
        {#if external}
          {#if live}
            <span class="track-row__duration">LIVE</span>
          {:else if track.duration_ms > 0}
            <span class="track-row__duration">{formatTime(track.duration_ms / 1000)}</span>
          {/if}
        {:else}
          <span class="track-row__duration">{formatTime(track.duration_ms / 1000)}</span>
          <span
            class="track-row__plays"
            title={tp("ui.trackRow.plays", plays)}
            aria-label={tp("ui.trackRow.plays", plays)}
          >({plays})</span>
          <MetaBadgeCluster {missingMeta} {moods} variant="inline" />
          <TrackLyricsIcon kind={trackLyricsKind} class="track-row__lyrics-inline--stats" />
        {/if}
      </span>
    </span>
    <span class="track-row__meta">
      <span
        class="track-row__meta-text"
        title={metaText}
      >
        {metaText}
      </span>
      <TrackLyricsIcon kind={trackLyricsKind} class="track-row__lyrics-inline--meta" />
    </span>
  </button>

  <div class="track-row__actions">
    <div class="track-row__tools track-row__tools--wide">
      {#if showQueueActions}
        {#if inQueue}
          <button
            type="button"
            class="track-row__in-coda"
            title={t("trackRow.removeQueue")}
            aria-label={t("trackRow.removeQueue")}
            onclick={removeFromQueue}
          >
            <span class="track-row__in-coda__label track-row__in-coda__label--idle">{t("trackRow.inQueueIdle")}</span>
            <span class="track-row__in-coda__label track-row__in-coda__label--act">{t("trackRow.inQueueAct")}</span>
          </button>
        {:else}
          <button
            type="button"
            class="track-row__ic track-row__ic--queue"
            title={t("trackRow.addQueue")}
            aria-label={t("trackRow.addQueue")}
            onclick={addToQueue}
          >
            <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
              <UiIcon name="add" />
            </span>
          </button>
        {/if}
      {/if}

      {#if !external}
      <button
        type="button"
        class="track-row__ic track-row__ic--fav"
        class:is-on={favorited}
        title={t("player.favorite")}
        aria-pressed={favorited}
        aria-label={t("player.favorite")}
        onclick={ontoggleFavorite}
      >
        <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
          <UiIcon name="favorite" />
        </span>
      </button>

      {#if showPlaylistAction && !external}
        <div class="track-row__playlist-anchor" bind:this={playlistAnchorEl}>
          <button
            type="button"
            class="track-row__ic track-row__ic--playlist"
            class:is-on={playlistOpen}
            title={t("trackRow.playlistTitle")}
            aria-label={t("trackRow.playlistAria")}
            aria-expanded={playlistOpen}
            onclick={() => {
              playlistOpen = !playlistOpen;
              menuOpen = false;
            }}
          >
            <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
              <UiIcon name="queueMusic" />
            </span>
          </button>
          {#if playlistOpen}
            <div
              class="track-row__playlist-popover rk-scroll"
              role="dialog"
              aria-label={t("trackRow.playlistTitle")}
              use:floating={{ anchor: playlistAnchorEl, placement: "bottom-end" }}
            >
              {#if resolvedPlaylistOptions.length}
                <ul class="track-row__playlist-popover-list">
                  {#each resolvedPlaylistOptions as opt (opt.value)}
                    <li>
                      <button
                        type="button"
                        class="track-row__playlist-popover-item"
                        onclick={() => run(() => addToPlaylist(opt.value))}
                      >
                        <span class="track-row__playlist-popover-item__name">{opt.label}</span>
                        <span class="track-row__playlist-popover-item__state">+</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="track-row__playlist-popover-empty">
                  {t("trackRow.playlistPickerEmpty")}
                </p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <button
        type="button"
        class="track-row__ic track-row__ic--meta"
        title={t("trackRow.editMeta")}
        aria-label={t("trackRow.editMeta")}
        onclick={editTrack}
      >
        <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
          <UiIcon name="edit" />
        </span>
      </button>
      {/if}

      {#if ontoggleExclude && !external}
        <button
          type="button"
          class="track-row__ic track-row__ic--exclude"
          class:is-on={excluded || albumLocked}
          disabled={albumLocked}
          title={albumLocked
            ? t("trackRow.excludeLockedByAlbumTitle")
            : excluded
              ? t("trackRow.unblockShuffle")
              : t("trackRow.blockShuffle")}
          aria-label={albumLocked
            ? t("trackRow.excludeLockedByAlbumAria")
            : excluded
              ? t("trackRow.unblockShuffle")
              : t("trackRow.blockShuffle")}
          onclick={() => ontoggleExclude?.()}
        >
          <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
            <UiIcon name="exclude" />
          </span>
        </button>
      {/if}

      {#if onremove && removeInline}
        <button
          type="button"
          class="track-row__ic track-row__ic--danger"
          title={t("trackRow.remove")}
          aria-label={t("trackRow.remove")}
          onclick={() => onremove?.()}
        >
          <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
            <UiIcon name="close" />
          </span>
        </button>
      {/if}
    </div>
    <div class="track-row__tools track-row__tools--compact">
      <div class="track-row__overflow" bind:this={overflowEl}>
        <button
          type="button"
          class="track-row__ic track-row__ic--overflow"
          title={t("player.moreActions")}
          aria-label={t("trackRow.overflowAria")}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onclick={() => {
            menuOpen = !menuOpen;
            playlistOpen = false;
          }}
        >
          <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
            <UiIcon name="more" />
          </span>
        </button>
        {#if menuOpen}
          <ul
            class="track-row__overflow-menu rk-scroll"
            role="menu"
            use:floating={{ anchor: overflowEl, placement: "bottom-end" }}
          >
            {#if !external}
            <li role="presentation">
              <button
                type="button"
                role="menuitem"
                class="track-row__overflow-item"
                class:is-on={favorited}
                title={t("player.favorite")}
                aria-label={t("player.favorite")}
                onclick={() => run(ontoggleFavorite)}
              >
                <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                  <UiIcon name="favorite" />
                </span>
                <span class="track-row__overflow-item-label">{t("player.favorite")}</span>
              </button>
            </li>
            {/if}
            {#if showQueueActions}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={inQueue}
                  title={inQueue ? t("trackRow.removeQueue") : t("trackRow.addQueue")}
                  onclick={() => run(inQueue ? removeFromQueue : addToQueue)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name={inQueue ? "close" : "add"} />
                  </span>
                  <span class="track-row__overflow-item-label">
                    {inQueue ? t("trackRow.removeQueue") : t("trackRow.addQueue")}
                  </span>
                </button>
              </li>
            {/if}
            {#if showPlaylistAction && !external}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={playlistOpen}
                  title={t("trackRow.playlistTitle")}
                  onclick={() => {
                    menuOpen = false;
                    playlistOpen = true;
                  }}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="queueMusic" />
                  </span>
                  <span class="track-row__overflow-item-label">{t("trackRow.playlistTitle")}</span>
                </button>
              </li>
            {/if}
            {#if !external}
            <li role="presentation">
              <button
                type="button"
                role="menuitem"
                class="track-row__overflow-item"
                title={t("trackRow.editMeta")}
                onclick={() => run(editTrack)}
              >
                <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                  <UiIcon name="edit" />
                </span>
                <span class="track-row__overflow-item-label">{t("trackRow.overflowEdit")}</span>
              </button>
            </li>
            {/if}
            {#if ontoggleExclude && !external}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={excluded || albumLocked}
                  disabled={albumLocked}
                  title={albumLocked
                    ? t("trackRow.excludeLockedByAlbumTitle")
                    : excluded
                      ? t("trackRow.unblockShuffle")
                      : t("trackRow.blockShuffle")}
                  onclick={() => run(ontoggleExclude)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="exclude" />
                  </span>
                  <span class="track-row__overflow-item-label">
                    {excluded ? t("trackRow.unblockShuffle") : t("trackRow.blockShuffle")}
                  </span>
                </button>
              </li>
            {/if}
            {#if onremove}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  title={t("trackRow.remove")}
                  onclick={() => run(onremove)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="close" />
                  </span>
                  <span class="track-row__overflow-item-label">{t("trackRow.remove")}</span>
                </button>
              </li>
            {/if}
          </ul>
        {/if}
        {#if playlistOpen && showPlaylistAction && !external}
          <div
            class="track-row__playlist-popover rk-scroll"
            role="dialog"
            aria-label={t("trackRow.playlistTitle")}
            use:floating={{ anchor: overflowEl, placement: "bottom-end" }}
          >
            {#if resolvedPlaylistOptions.length}
              <ul class="track-row__playlist-popover-list">
                {#each resolvedPlaylistOptions as opt (opt.value)}
                  <li>
                    <button
                      type="button"
                      class="track-row__playlist-popover-item"
                      onclick={() => run(() => addToPlaylist(opt.value))}
                    >
                      <span class="track-row__playlist-popover-item__name">{opt.label}</span>
                      <span class="track-row__playlist-popover-item__state">+</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="track-row__playlist-popover-empty">
                {t("trackRow.playlistPickerEmpty")}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Reorder handle last, where legacy had its ↑/↓ buttons. -->
    {#if reorderIndex != null}
      <button
        type="button"
        class="track-row__ic track-row__grip"
        data-reorder-handle
        title={t("trackRow.reorderTitle")}
        aria-label={t("trackRow.reorderAria")}
        onkeydown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          onreorderStep?.(e.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
          <UiIcon name="dragHandle" />
        </span>
      </button>
    {/if}

    {#if extraActions}
      {@render extraActions()}
    {/if}
  </div>
</li>
