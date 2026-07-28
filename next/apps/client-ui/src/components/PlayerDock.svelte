<script lang="ts">
  import { CoverArt, IconButton } from "@rekord/ui";
  import { albumCoverUrl, type Track } from "../lib/api";
  import type { RepeatMode } from "../lib/player";
  import UiIcon from "./icons/UiIcon.svelte";
  import PlayerTimeline from "./PlayerTimeline.svelte";
  import PlayerTransport from "./PlayerTransport.svelte";
  import SleepTimerControl from "./SleepTimerControl.svelte";

  let {
    current = null,
    playing = false,
    currentTime = 0,
    duration = 0,
    shuffle = false,
    repeat = "off" as RepeatMode,
    favorited = false,
    excluded = false,
    excludeLocked = false,
    ontoggle,
    onprev,
    onnext,
    onseek,
    ontoggleShuffle,
    oncycleRepeat,
    ontoggleFavorite,
    ontoggleExclude,
    onradio,
    onopenAlbum,
    onopenArtist,
    onopenStudio,
  }: {
    current?: Track | null;
    playing?: boolean;
    currentTime?: number;
    duration?: number;
    shuffle?: boolean;
    repeat?: RepeatMode;
    favorited?: boolean;
    excluded?: boolean;
    excludeLocked?: boolean;
    ontoggle: () => void;
    onprev: () => void;
    onnext: () => void;
    onseek: (seconds: number) => void;
    ontoggleShuffle: () => void;
    oncycleRepeat: () => void;
    ontoggleFavorite: () => void;
    ontoggleExclude: () => void;
    onradio: () => void;
    onopenAlbum: () => void;
    onopenArtist: () => void;
    onopenStudio?: () => void;
  } = $props();

  let barEl: HTMLElement | undefined = $state();

  $effect(() => {
    const bar = barEl;
    if (!bar) return;

    const root = document.documentElement;
    const apply = () => {
      const h = Math.max(0, Math.ceil(bar.getBoundingClientRect().height));
      root.style.setProperty("--rk-dock-h", `${h}px`);
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);

    return () => {
      ro.disconnect();
      root.style.removeProperty("--rk-dock-h");
    };
  });
</script>

<footer class="dock">
  <div class="bar" bind:this={barEl}>
    <div class="row top">
      <div class="identity">
        <button
          type="button"
          class="art-hit"
          onclick={() => (onopenStudio ? onopenStudio() : onopenAlbum())}
          title="Apri Studio Ascolta"
        >
          <CoverArt
            title={current?.title ?? ""}
            seed={current ? `${current.artist_name}/${current.album_name}` : ""}
            src={current?.album_id != null ? albumCoverUrl(current.album_id) : ""}
            size="dock"
          />
        </button>
        <div class="meta">
          {#if current}
            <strong>{current.title}</strong>
            <div class="byline">
              <button type="button" class="crumb" onclick={onopenArtist}>
                {current.artist_name}
              </button>
              <span class="sep">·</span>
              <button type="button" class="crumb" onclick={onopenAlbum}>
                {current.album_name}
              </button>
            </div>
          {:else}
            <strong>Nessuna riproduzione</strong>
            <div class="byline idle">Scegli un brano dalla libreria</div>
          {/if}
        </div>
      </div>

      <div class="transport-wrap">
        <PlayerTransport
          {playing}
          {shuffle}
          {repeat}
          {favorited}
          {excluded}
          {excludeLocked}
          {ontoggle}
          {onprev}
          {onnext}
          {ontoggleShuffle}
          {oncycleRepeat}
          {ontoggleFavorite}
          {ontoggleExclude}
        />
      </div>

      <div class="rail-end">
        <SleepTimerControl />
        <IconButton label="Radio da brano" onclick={onradio}>
          <UiIcon name="radio" />
        </IconButton>
      </div>
    </div>
    <div class="row seek">
      <PlayerTimeline {currentTime} {duration} {onseek} />
    </div>
  </div>
</footer>

<style>
  .dock {
    position: fixed;
    left: var(--rk-side-w);
    right: 0;
    bottom: 0;
    z-index: var(--rk-z-player);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .bar {
    background: var(--rk-sidebar-bg);
    border-top: 1px solid var(--rk-line);
    padding: var(--rk-space-3) var(--rk-space-4) var(--rk-space-2);
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-2);
  }

  .row.top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    column-gap: 0.75rem;
    width: 100%;
    min-width: 0;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    min-width: 0;
    justify-self: start;
  }

  .art-hit {
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
    border-radius: var(--rk-radius);
    line-height: 0;
  }

  .meta {
    display: grid;
    gap: 0.22rem;
    min-width: 0;
  }

  .meta strong {
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .byline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.2rem 0.45rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--rk-ink) 72%, var(--rk-muted) 28%);
  }

  .byline.idle {
    font-weight: 500;
    color: var(--rk-muted);
  }

  .crumb {
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    color: color-mix(in srgb, var(--rk-accent-2) 82%, var(--rk-ink) 18%);
  }

  .crumb:hover {
    color: var(--rk-accent-2);
    text-decoration: underline;
    text-underline-offset: 0.12em;
  }

  .sep {
    color: var(--rk-muted);
  }

  .transport-wrap {
    justify-self: center;
    grid-column: 2;
  }

  .rail-end {
    display: none;
  }

  @media (min-width: 1001px) {
    .rail-end {
      display: inline-flex;
      grid-column: 3;
      justify-self: end;
      align-items: center;
      gap: 0.42rem;
    }
  }

  @media (max-width: 1000px) {
    .dock {
      left: 0;
      bottom: var(--rk-mobile-nav-h);
    }

    .row.top {
      grid-template-columns: 1fr;
      row-gap: 0.45rem;
    }

    .transport-wrap {
      grid-column: 1;
      justify-self: center;
    }
  }
</style>
