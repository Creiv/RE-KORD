<script lang="ts" module>
  /** Una sola popover aperta tra tutte le TrackRow. */
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
  import { onMount } from "svelte";
  import { albumCoverUrl, type Track } from "../lib/api";
  import { formatTime, player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import { previewGenre, resolveTrackMoods } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";
  import GraphicEq from "./icons/GraphicEq.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import MetaBadgeCluster from "./MetaBadgeCluster.svelte";
  import TrackLyricsIcon from "./TrackLyricsIcon.svelte";

  /** Parity old TRACK_ROW_INLINE_ACTIONS_MIN_PX */
  const INLINE_ACTIONS_MIN_PX = 651;

  let {
    track,
    index = 0,
    revision = 0,
    favorited = false,
    active = false,
    playlistOptions = [],
    autoFocusActive = true,
    extraActions = null as import("svelte").Snippet | null,
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
    revision?: number;
    favorited?: boolean;
    active?: boolean;
    playlistOptions?: SelectOption[];
    autoFocusActive?: boolean;
    extraActions?: import("svelte").Snippet | null;
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
  /** Come old useElementMinWidth: default false finché non misuriamo (≥651 → wide). */
  let wide = $state(false);
  let prevActive = false;

  const inQueue = $derived.by(() => {
    revision;
    return player.isInQueue(track.id);
  });
  const excluded = $derived.by(() => {
    revision;
    return player.isTrackExcluded(track);
  });
  const albumLocked = $derived.by(() => {
    revision;
    return track.album_id != null && player.isAlbumExcluded(track.album_id);
  });
  const plays = $derived.by(() => {
    revision;
    return player.playCount(track);
  });
  const moods = $derived.by(() => {
    revision;
    return resolveTrackMoods(track.id, track.rel_path, loadUserPrefs().trackMoods);
  });
  const genre = $derived(previewGenre(track.rel_path));
  /** Come old: EQ se riga attiva; animazione solo in play. */
  const showStudio = $derived(active);
  const lyricsKind = $derived(
    (hashSeed(track.rel_path) % 5 === 0
      ? "lrc"
      : hashSeed(track.rel_path) % 3 === 0
        ? "plain"
        : "off") as "off" | "plain" | "lrc",
  );
  /** Come old: icona lyrics anche in stato off (ghost); nascosta solo se kind=hidden. */
  const showLyricsIcon = true;

  function hashSeed(s: string) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  onMount(() => {
    if (!rowEl) return;
    const sync = () => {
      const next = rowEl!.getBoundingClientRect().width >= INLINE_ACTIONS_MIN_PX;
      wide = next;
      if (next) {
        menuOpen = false;
        playlistOpen = false;
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(rowEl);
    return () => ro.disconnect();
  });

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

  /** Come old usePopoverLayerAnchored: fuori click, Esc, scroll (capture), resize — document-level. */
  $effect(() => {
    if (!menuOpen && !playlistOpen) return;

    const dismiss = () => {
      menuOpen = false;
      playlistOpen = false;
    };
    const releaseExclusive = claimTrackRowPopover(dismiss);

    const insidePopover = (t: EventTarget | null) => {
      if (!(t instanceof Node)) return false;
      if (overflowEl?.contains(t)) return true;
      if (playlistAnchorEl?.contains(t)) return true;
      return false;
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
  class:track-row--compact-tools={!wide}
>
  <div class="track-row__art-wrap">
    <CoverArt
      title={track.title}
      seed={`${track.artist_name}/${track.album_name}`}
      src={track.album_id != null ? albumCoverUrl(track.album_id) : ""}
      size="md"
    />
    {#if showStudio}
      <button
        type="button"
        class="track-row__art-studio"
        title="Apri Studio Ascolta"
        aria-label="Apri Studio Ascolta"
        onclick={openStudio}
      >
        <GraphicEq animated={session.playing} />
      </button>
    {:else}
      <button
        type="button"
        class="track-row__art-play"
        title="Riproduci"
        aria-label="Riproduci"
        onclick={onplay}
      >
        <UiIcon name="play" />
      </button>
    {/if}
  </div>

  <button type="button" class="track-row__main" onclick={onplay}>
    <span class="track-row__title-row">
      <span class="track-row__title">{track.title}</span>
      <span class="track-row__stats">
        <span class="track-row__duration">{formatTime(track.duration_ms / 1000)}</span>
        <span class="track-row__plays">({plays})</span>
        <MetaBadgeCluster missingMeta={!genre} {moods} variant="inline" />
        <TrackLyricsIcon kind={lyricsKind} class="track-row__lyrics-inline--stats" />
      </span>
    </span>
    <span class="track-row__meta">
      <span class="track-row__meta-text">{track.artist_name} · {track.album_name}</span>
      {#if showLyricsIcon}
        <span class="track-row__meta-sep" aria-hidden="true">{" "}·{" "}</span>
        <TrackLyricsIcon kind={lyricsKind} class="track-row__lyrics-inline--meta" />
      {/if}
    </span>
  </button>

  <div
    class="track-row__actions"
    class:track-row__actions--compact-tools={!wide}
  >
    {#if wide}
      {#if onaddToQueue || onremoveFromQueue}
        {#if inQueue}
          <button
            type="button"
            class="track-row__in-coda"
            title="Rimuovi dalla coda"
            aria-label="Rimuovi dalla coda"
            onclick={() => onremoveFromQueue?.()}
          >
            <span class="track-row__in-coda__label track-row__in-coda__label--idle">in coda</span>
            <span class="track-row__in-coda__label track-row__in-coda__label--act">rimuovi</span>
          </button>
        {:else}
          <button
            type="button"
            class="track-row__ic track-row__ic--queue"
            title="Riproduci come prossimo"
            aria-label="Riproduci come prossimo"
            onclick={() => onaddToQueue?.()}
          >
            <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
              <UiIcon name="add" />
            </span>
          </button>
        {/if}
      {/if}

      <button
        type="button"
        class="track-row__ic track-row__ic--fav"
        class:is-on={favorited}
        title="Preferito"
        aria-pressed={favorited}
        aria-label="Preferito"
        onclick={ontoggleFavorite}
      >
        <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
          <UiIcon name="favorite" />
        </span>
      </button>

      {#if onaddToPlaylist}
        <div class="track-row__playlist-anchor" bind:this={playlistAnchorEl}>
          <button
            type="button"
            class="track-row__ic track-row__ic--playlist"
            class:is-on={playlistOpen}
            title="Playlist"
            aria-label="Scegli le playlist in cui aggiungere o da cui rimuovere il brano"
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
            <div class="track-row__playlist-popover rk-scroll" role="dialog" aria-label="Playlist">
              {#if playlistOptions.length}
                <ul class="track-row__playlist-popover-list">
                  {#each playlistOptions as opt}
                    <li>
                      <button
                        type="button"
                        class="track-row__playlist-popover-item"
                        onclick={() => run(() => onaddToPlaylist?.(opt.value))}
                      >
                        <span class="track-row__playlist-popover-item__name">{opt.label}</span>
                        <span class="track-row__playlist-popover-item__state">+</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="track-row__playlist-popover-empty">
                  Non hai playlist. Creane una dalla sezione Playlist.
                </p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if onedit}
        <button
          type="button"
          class="track-row__ic track-row__ic--meta"
          title="Modifica metadati brano"
          aria-label="Modifica metadati brano"
          onclick={() => onedit?.()}
        >
          <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
            <UiIcon name="edit" />
          </span>
        </button>
      {/if}

      {#if ontoggleExclude}
        <button
          type="button"
          class="track-row__ic track-row__ic--exclude"
          class:is-on={excluded || albumLocked}
          disabled={albumLocked}
          title={albumLocked
            ? "Album bloccato dallo shuffle: sblocca l’album per modificare i singoli brani"
            : excluded
              ? "Sblocca da shuffle"
              : "Blocca da shuffle"}
          aria-label={albumLocked
            ? "Blocco shuffle impostato sull’album"
            : excluded
              ? "Sblocca da shuffle"
              : "Blocca da shuffle"}
          onclick={() => ontoggleExclude?.()}
        >
          <span class="track-row__ic-glyph track-row__ic-glyph--svg" aria-hidden="true">
            <UiIcon name="exclude" />
          </span>
        </button>
      {/if}

      {#if extraActions}
        {@render extraActions()}
      {/if}
    {:else}
      <div class="track-row__overflow" bind:this={overflowEl}>
        <button
          type="button"
          class="track-row__ic track-row__ic--overflow"
          title="Altre azioni sul brano"
          aria-label="Apri il menu delle altre azioni sul brano"
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
          <ul class="track-row__overflow-menu rk-scroll" role="menu">
            <li role="presentation">
              <button
                type="button"
                role="menuitem"
                class="track-row__overflow-item"
                class:is-on={favorited}
                title="Preferito"
                aria-label="Preferito"
                onclick={() => run(ontoggleFavorite)}
              >
                <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                  <UiIcon name="favorite" />
                </span>
                <span class="track-row__overflow-item-label">Preferito</span>
              </button>
            </li>
            {#if onaddToQueue || onremoveFromQueue}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={inQueue}
                  title={inQueue ? "Rimuovi dalla coda" : "Riproduci come prossimo"}
                  onclick={() => run(inQueue ? onremoveFromQueue : onaddToQueue)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name={inQueue ? "close" : "add"} />
                  </span>
                  <span class="track-row__overflow-item-label">
                    {inQueue ? "Rimuovi dalla coda" : "Riproduci come prossimo"}
                  </span>
                </button>
              </li>
            {/if}
            {#if onaddToPlaylist}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={playlistOpen}
                  title="Playlist"
                  onclick={() => {
                    menuOpen = false;
                    playlistOpen = true;
                  }}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="queueMusic" />
                  </span>
                  <span class="track-row__overflow-item-label">Playlist</span>
                </button>
              </li>
            {/if}
            {#if onedit}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  title="Modifica metadati brano"
                  onclick={() => run(onedit)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="edit" />
                  </span>
                  <span class="track-row__overflow-item-label">Modifica</span>
                </button>
              </li>
            {/if}
            {#if ontoggleExclude}
              <li role="presentation">
                <button
                  type="button"
                  role="menuitem"
                  class="track-row__overflow-item"
                  class:is-on={excluded || albumLocked}
                  disabled={albumLocked}
                  title={albumLocked
                    ? "Album bloccato dallo shuffle: sblocca l’album per modificare i singoli brani"
                    : excluded
                      ? "Sblocca da shuffle"
                      : "Blocca da shuffle"}
                  onclick={() => run(ontoggleExclude)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="exclude" />
                  </span>
                  <span class="track-row__overflow-item-label">
                    {excluded ? "Sblocca da shuffle" : "Blocca da shuffle"}
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
                  title="Rimuovi"
                  onclick={() => run(onremove)}
                >
                  <span class="track-row__overflow-item-glyph track-row__ic-glyph--svg" aria-hidden="true">
                    <UiIcon name="close" />
                  </span>
                  <span class="track-row__overflow-item-label">Rimuovi</span>
                </button>
              </li>
            {/if}
          </ul>
        {/if}
        {#if playlistOpen && onaddToPlaylist}
          <div class="track-row__playlist-popover rk-scroll" role="dialog" aria-label="Playlist">
            {#if playlistOptions.length}
              <ul class="track-row__playlist-popover-list">
                {#each playlistOptions as opt}
                  <li>
                    <button
                      type="button"
                      class="track-row__playlist-popover-item"
                      onclick={() => run(() => onaddToPlaylist?.(opt.value))}
                    >
                      <span class="track-row__playlist-popover-item__name">{opt.label}</span>
                      <span class="track-row__playlist-popover-item__state">+</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="track-row__playlist-popover-empty">
                Non hai playlist. Creane una dalla sezione Playlist.
              </p>
            {/if}
          </div>
        {/if}
      </div>

      {#if extraActions}
        {@render extraActions()}
      {/if}
    {/if}
  </div>
</li>
