<script lang="ts">
  /**
   * Dashboard › Ascolto veloce: a stable per-visit pick of tracks (recent,
   * favourites, then the catalog, one per album first) as big cover tiles;
   * tapping one starts a radio from it. The last tile shuffles the library.
   */
  import { onMount, untrack } from "svelte";
  import { CoverArt, Panel, Skeleton } from "@rekord/ui";
  import SectionHeadLead from "../../SectionHeadLead.svelte";
  import TrackMoodGlyph from "../../TrackMoodGlyph.svelte";
  import GraphicEq from "../../icons/GraphicEq.svelte";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { coverUrlFor, type Track } from "../../../lib/api";
  import { matchesDown } from "../../../lib/breakpoints";
  import { t } from "../../../lib/i18n.svelte";
  import { player } from "../../../lib/player";
  import { stripTrackNumberPrefix } from "../../../lib/search";
  import { session } from "../../../lib/session.svelte";
  import {
    TRACK_MOOD_COLORS,
    resolveTrackMoods,
    trackMoodLabelKey,
    type TrackMoodId,
  } from "../../../lib/trackMoods";
  import { loadUserPrefs } from "../../../lib/userPrefs";

  let { loading = false }: { loading?: boolean } = $props();

  type RadioTile = {
    id: number;
    title: string;
    artist: string;
    moods: TrackMoodId[];
    track: Track;
  };

  const MIN_COLS = 3;
  const MAX_COLS = 8;
  /** Bigger tiles than the first port (5.5rem): covers read as covers. */
  const MIN_TILE_REM = 8.5;

  let gridEl = $state<HTMLDivElement | null>(null);
  let columns = $state(6);
  /** Stable snapshot per visit (legacy lazy useState). */
  let picks = $state<RadioTile[]>([]);

  function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  function pickTiles(maxTracks: number): RadioTile[] {
    const prefs = loadUserPrefs().trackMoods;
    const recent: Track[] = [];
    for (const path of player.recentRelPaths().slice(0, 2)) {
      const tr =
        session.catalogTracks.find((x) => x.rel_path === path) ||
        session.favorites.find((x) => x.rel_path === path) ||
        session.queue.find((x) => x.rel_path === path);
      if (tr) recent.push(tr);
    }
    const pool = [...recent, ...session.favorites, ...session.catalogTracks];
    const seen = new Set<number>();
    const seenAlbum = new Set<number | string>();
    const uniqueAlbum: Track[] = [];
    const rest: Track[] = [];
    for (const tr of pool) {
      if (seen.has(tr.id) || player.isTrackExcluded(tr)) continue;
      seen.add(tr.id);
      const key = tr.album_id ?? `t:${tr.id}`;
      if (!seenAlbum.has(key)) {
        seenAlbum.add(key);
        uniqueAlbum.push(tr);
      } else {
        rest.push(tr);
      }
    }
    const picked: Track[] = [];
    for (const tr of shuffleInPlace(uniqueAlbum)) {
      if (picked.length >= maxTracks) break;
      picked.push(tr);
    }
    for (const tr of shuffleInPlace(rest)) {
      if (picked.length >= maxTracks) break;
      picked.push(tr);
    }
    return picked.map((tr) => ({
      id: tr.id,
      title: stripTrackNumberPrefix(tr.title),
      artist: tr.artist_name,
      moods: resolveTrackMoods(tr.id, tr.rel_path, prefs),
      track: tr,
    }));
  }

  onMount(() => {
    if (session.catalogTracks.length || session.favorites.length) picks = pickTiles(MAX_COLS);
  });

  // First fill once the catalog arrives; afterwards the pick stays put for the visit.
  $effect(() => {
    const n = session.catalogTracks.length + session.favorites.length;
    if (picks.length > 0 || n === 0) return;
    untrack(() => (picks = pickTiles(MAX_COLS)));
  });

  $effect(() => {
    const el = gridEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const compute = () => {
      const width = el.clientWidth;
      if (width <= 8) return;
      const font = parseFloat(getComputedStyle(document.documentElement).fontSize || "16") || 16;
      const gap = parseFloat(getComputedStyle(el).columnGap || "") || 0.75 * font;
      const minTrack = Math.min(MIN_TILE_REM * font, width);
      const raw = Math.max(1, Math.floor((width + gap) / (minTrack + gap)));
      columns = matchesDown("sm")
        ? 3
        : Math.max(MIN_COLS, Math.min(matchesDown("lg") ? 5 : MAX_COLS, raw));
    };
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    return () => ro.disconnect();
  });

  /** One slot is the "random" tile. */
  const shown = $derived(picks.slice(0, Math.max(0, columns - 1)));

  function openListen() {
    session.studioPane = "listen";
    session.navigate("studio");
  }

  function playFrom(track: Track) {
    const library = session.catalogTracks.length
      ? session.catalogTracks
      : session.favorites.length
        ? session.favorites
        : [track];
    // Start playback first; defer the Studio mount (visualizer) off the press path.
    void session.playGlobalRadio(track, library);
    window.setTimeout(openListen, 0);
  }

  function shuffleAll() {
    void session.shuffleLibrary().then(openListen);
  }
</script>

<Panel class="session-card dashboard-session-card dashboard-smart-radio-card dashboard-page__full dashboard-page__mix">
  <header class="section-head section-head--page-toolbar">
    <SectionHeadLead eyebrow={t("dashboard.radioEyebrow")} title={t("dashboard.radioTitle")}>
      <UiIcon name="radio" />
    </SectionHeadLead>
  </header>
  {#if shown.length === 0 && loading}
    <Skeleton variant="tile" count={4} label={t("dashboard.loading")} />
  {:else}
    <div
      class="dashboard-smart-radio-grid dash-radio-grid"
      bind:this={gridEl}
      style="--smart-radio-cols: {columns}"
    >
      {#each shown as tile (tile.id)}
        {@const isCurrent = session.current?.id === tile.id}
        <div class="dashboard-smart-radio-tile" class:dashboard-smart-radio-tile--active={isCurrent}>
          <div class="dashboard-smart-radio-tile__media">
            <CoverArt
              kind="track"
              class="dash-cover-fill"
              title={tile.title}
              src={coverUrlFor(tile.track, 256)}
              rounded={false}
            />
            {#if isCurrent}
              <button
                type="button"
                class="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__studio"
                title={t("dashboard.openStudio")}
                aria-label={t("dashboard.openStudio")}
                onclick={openListen}
              >
                <GraphicEq animated={session.playing} live beat={Math.floor(session.currentTime)} />
              </button>
            {:else}
              <button
                type="button"
                class="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__play"
                title={t("dashboard.radioFrom", { title: tile.title })}
                aria-label={t("dashboard.radioFrom", { title: tile.title })}
                onclick={() => playFrom(tile.track)}
              >
                <UiIcon name="play" />
              </button>
            {/if}
          </div>
          <button
            type="button"
            class="dashboard-smart-radio-tile__meta"
            title={t("dashboard.radioFrom", { title: tile.title })}
            onclick={() => playFrom(tile.track)}
          >
            <span class="dashboard-smart-radio-tile__title">{tile.title}</span>
            <span class="dash-radio-artist">{tile.artist}</span>
            {#if tile.moods.length}
              <span class="dash-radio-moods">
                {#each tile.moods as m (m)}
                  <span
                    class="dash-radio-mood"
                    style="--mood-c: {TRACK_MOOD_COLORS[m]}"
                    title={t(trackMoodLabelKey(m))}
                    role="img"
                    aria-label={t(trackMoodLabelKey(m))}
                  >
                    <TrackMoodGlyph mood={m} class="track-meta-mood-chip__glyph" />
                  </span>
                {/each}
              </span>
            {/if}
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="dashboard-smart-radio-tile dashboard-smart-radio-tile--random"
        title={t("dashboard.random")}
        aria-label={t("dashboard.random")}
        onclick={shuffleAll}
      >
        <span class="dashboard-smart-radio-tile__media dashboard-smart-radio-tile__media--random" aria-hidden="true">
          <UiIcon name="shuffle" />
        </span>
        <span class="dashboard-smart-radio-tile__meta">
          <span class="dashboard-smart-radio-tile__title">{t("dashboard.random")}</span>
          <span class="dash-radio-artist">{t("dashboard.randomHint")}</span>
        </span>
      </button>
    </div>
  {/if}
</Panel>

<style>
  .dash-radio-grid {
    gap: 1rem 0.85rem;
  }

  :global(.rk-cover.dash-cover-fill.dash-cover-fill) {
    width: 100%;
    height: 100%;
    border: 0;
    --cover-initials: 1.5rem;
  }

  .dash-radio-grid :global(.dashboard-smart-radio-tile__title) {
    font-size: var(--rk-fs-sm);
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }

  .dash-radio-artist {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dash-radio-moods {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.2rem;
  }

  .dash-radio-mood {
    display: inline-grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    /* Legacy chip: rounded square, not a dot. */
    border-radius: var(--rk-radius, 6px);
    color: color-mix(in srgb, var(--mood-c) 88%, var(--rk-ink));
    background: color-mix(in srgb, var(--mood-c) 18%, var(--rk-surface-2) 82%);
    border: 1px solid color-mix(in srgb, var(--mood-c) 42%, var(--rk-line) 58%);
  }

  .dash-radio-mood :global(.track-meta-mood-chip__glyph),
  .dash-radio-mood :global(.track-meta-mood-chip__glyph :is(svg, .mood-g)) {
    width: 0.75rem;
    height: 0.75rem;
    display: block;
  }
</style>
