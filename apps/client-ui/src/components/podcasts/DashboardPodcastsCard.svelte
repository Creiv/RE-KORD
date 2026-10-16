<script lang="ts">
  /**
   * Dashboard › Podcast e notizie. One source: its latest episode up front
   * (artwork, title, time, play) and the next two as rows. Several: one tile
   * per source with its newest episode, in a horizontal row like "Ascolto
   * veloce". Loaded only when the hub has the module on; never polled.
   *
   * A click never starts the newest episode by itself: a show with an
   * unfinished episode asks "continue?", any other opens its page. Live
   * stations play at once; the episode rows keep their own play buttons.
   */
  import { onMount } from "svelte";
  import { Button, CoverArt, EmptyState, Panel, Skeleton } from "@rekord/ui";
  import SectionHeadLead from "../SectionHeadLead.svelte";
  import GraphicEq from "../icons/GraphicEq.svelte";
  import UiIcon from "../icons/UiIcon.svelte";
  import { apiUrl } from "../../lib/config";
  import { confirmChoice } from "../../lib/confirm.svelte";
  import { fmtRelative, t } from "../../lib/i18n.svelte";
  import { player } from "../../lib/player";
  import {
    cardAction,
    episodesFor,
    formatDuration,
    isNewEpisode,
    visibleSources,
    type PodcastEpisode,
    type PodcastSource,
  } from "../../lib/podcastModel";
  import { podcasts } from "../../lib/podcasts/store.svelte";
  import { session } from "../../lib/session.svelte";
  import EpisodeRow from "./EpisodeRow.svelte";
  import LiveTile from "./LiveTile.svelte";

  onMount(() => {
    void podcasts.load();
  });

  const sources = $derived(visibleSources(podcasts.sources));
  const single = $derived(sources.length === 1 ? sources[0]! : null);
  const singleEpisodes = $derived(single && !single.live ? episodesFor(single).slice(0, 3) : []);
  const feature = $derived(singleEpisodes[0] ?? null);

  function artFor(source: PodcastSource, ep: PodcastEpisode | null): string | null {
    if (ep && (ep.hasArt || source.hasArt)) {
      return apiUrl(`/api/v1/podcasts/art/${source.id}/${encodeURIComponent(ep.key)}`);
    }
    return source.hasArt ? apiUrl(`/api/v1/podcasts/art/${source.id}/_`) : null;
  }

  function isPlaying(source: PodcastSource, ep: PodcastEpisode): boolean {
    void session.tick;
    return podcasts.isCurrent(source, ep) && session.playing;
  }

  function toggle(source: PodcastSource, ep: PodcastEpisode) {
    if (isPlaying(source, ep)) player.pause();
    else podcasts.play(source, ep);
  }

  /** Whether a click on this show would offer to continue an episode. */
  function resumable(source: PodcastSource): boolean {
    return cardAction(podcasts.state, source).kind === "ask";
  }

  /** Click on a show (tile, artwork, title): see `cardAction`. */
  async function openShow(source: PodcastSource, ep: PodcastEpisode) {
    // The episode already playing (or paused) here: just play / pause it.
    if (podcasts.isCurrent(source, ep)) {
      toggle(source, ep);
      return;
    }
    const action = cardAction(podcasts.state, source);
    if (action.kind === "live") {
      toggle(source, ep);
      return;
    }
    if (action.kind === "open") {
      podcasts.openSource(source.id);
      return;
    }
    const at = formatDuration(action.resumeAt);
    const choice = await confirmChoice({
      title: t("podcasts.continueTitle", { title: action.ep.title }),
      message: at ? t("podcasts.continueAt", { at }) : undefined,
      confirmLabel: t("podcasts.continue"),
      altLabel: t("podcasts.openShow"),
    });
    if (choice === "confirm") podcasts.play(source, action.ep);
    else if (choice === "alt") podcasts.openSource(source.id);
  }

  function openLabel(source: PodcastSource, ep: PodcastEpisode): string {
    if (isPlaying(source, ep)) return t("player.playPause");
    if (podcasts.isCurrent(source, ep)) return t("podcasts.play");
    return t("podcasts.openShow");
  }

  function glyphOf(source: PodcastSource, ep: PodcastEpisode): "play" | "chevronRight" {
    return podcasts.isCurrent(source, ep) || resumable(source) ? "play" : "chevronRight";
  }

  function metaOf(ep: PodcastEpisode): string[] {
    const parts: string[] = [];
    if (ep.publishedAt) parts.push(fmtRelative(ep.publishedAt));
    const d = formatDuration(ep.durationSecs);
    if (d) parts.push(d);
    return parts;
  }
</script>

<Panel class="session-card dashboard-session-card dashboard-page__full dashboard-page__tile podcast-card">
  <header class="section-head section-head--page-toolbar">
    <SectionHeadLead eyebrow={t("podcasts.eyebrow")} title={t("nav.podcasts")}>
      <UiIcon name="podcast" />
    </SectionHeadLead>
    <div class="section-head__tools">
      <button type="button" class="text-btn" onclick={() => session.navigate("podcasts")}>
        {t("podcasts.openAll")}
      </button>
    </div>
  </header>

  {#if !podcasts.loaded && podcasts.loading}
    <Skeleton variant="tile" count={4} label={t("podcasts.loading")} />
  {:else if podcasts.error && !podcasts.sources.length}
    <p class="podcast-card__error" role="alert">{podcasts.error}</p>
  {:else if !sources.length}
    <EmptyState variant="inline" title={t("podcasts.emptyTitle")} body={t("podcasts.emptyBody")}>
      {#snippet icon()}<UiIcon name="podcast" />{/snippet}
      {#snippet action()}
        <a class="text-btn" href={session.hubPanelUrl} target="_blank" rel="noopener noreferrer">
          {t("podcasts.openAdmin")}
        </a>
      {/snippet}
    </EmptyState>
  {:else if single?.live}
    <div class="podcast-card__live-one">
      <LiveTile source={single} />
    </div>
  {:else if single && feature}
    {@const playing = isPlaying(single, feature)}
    <div class="podcast-card__single" class:podcast-card__single--alone={singleEpisodes.length < 2}>
      <div class="podcast-feature" class:is-active={podcasts.isCurrent(single, feature)}>
        <button
          type="button"
          class="podcast-feature__art"
          title={openLabel(single, feature)}
          aria-label={openLabel(single, feature)}
          onclick={() => void openShow(single, feature)}
        >
          <CoverArt kind="album" class="podcast-feature__cover" title={feature.title} src={artFor(single, feature)} rounded={false} />
          <span class="podcast-feature__glyph" aria-hidden="true">
            {#if playing}<GraphicEq animated />{:else}<UiIcon name={glyphOf(single, feature)} />{/if}
          </span>
        </button>
        <div class="podcast-feature__text">
          <p class="rk-eyebrow podcast-feature__source">{single.name}</p>
          <h3 class="podcast-feature__title">{feature.title}</h3>
          <p class="podcast-feature__meta">
            {#each metaOf(feature) as part (part)}<span>{part}</span>{/each}
            {#if isNewEpisode(feature)}<span class="podcast-feature__new">{t("podcasts.new")}</span>{/if}
          </p>
          <div>
            {#if podcasts.isCurrent(single, feature)}
              <Button class="podcast-feature__play" onclick={() => toggle(single, feature)}>
                <UiIcon name={playing ? "pause" : "play"} />
                {playing ? t("player.playPause") : t("podcasts.resumeLatest")}
              </Button>
            {:else}
              <Button class="podcast-feature__play" onclick={() => void openShow(single, feature)}>
                <UiIcon name={resumable(single) ? "play" : "podcast"} />
                {resumable(single) ? t("podcasts.resumeLatest") : t("podcasts.openShow")}
              </Button>
            {/if}
          </div>
        </div>
      </div>
      {#if singleEpisodes.length > 1}
        <ul class="podcast-card__rows">
          {#each singleEpisodes.slice(1) as ep (ep.key)}
            <EpisodeRow source={single} {ep} />
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="podcast-card__strip rk-scroll" style="--pod-cols: {Math.min(Math.max(sources.length + 1, 5), 7)}">
      {#each sources as source (source.id)}
        {#if source.live}
          <div class="podcast-card__slot"><LiveTile {source} /></div>
        {:else}
          {@const ep = episodesFor(source)[0]}
          {#if ep}
            {@const current = podcasts.isCurrent(source, ep)}
            {@const playing = isPlaying(source, ep)}
            <div
              class="podcast-card__slot dashboard-smart-radio-tile"
              class:dashboard-smart-radio-tile--active={current}
            >
              <div class="dashboard-smart-radio-tile__media">
                <CoverArt kind="album" class="dash-cover-fill" title={source.name} src={artFor(source, ep)} rounded={false} />
                {#if isNewEpisode(ep)}<span class="podcast-card__new">{t("podcasts.new")}</span>{/if}
                <button
                  type="button"
                  class="dashboard-smart-radio-tile__overlay {current ? 'dashboard-smart-radio-tile__studio' : 'dashboard-smart-radio-tile__play'}"
                  title={openLabel(source, ep)}
                  aria-label={openLabel(source, ep)}
                  onclick={() => void openShow(source, ep)}
                >
                  {#if playing}<GraphicEq animated />{:else}<UiIcon name={glyphOf(source, ep)} />{/if}
                </button>
              </div>
              <button type="button" class="dashboard-smart-radio-tile__meta" onclick={() => void openShow(source, ep)}>
                <span class="dashboard-smart-radio-tile__title podcast-card__tile-title">{ep.title}</span>
                <span class="podcast-card__tile-sub">{source.name}</span>
                <span class="podcast-card__tile-sub">{metaOf(ep).join(" · ")}</span>
              </button>
            </div>
          {/if}
        {/if}
      {/each}
      <button
        type="button"
        class="podcast-card__slot dashboard-smart-radio-tile dashboard-smart-radio-tile--random"
        onclick={() => session.navigate("podcasts")}
      >
        <span class="dashboard-smart-radio-tile__media dashboard-smart-radio-tile__media--random podcast-card__all" aria-hidden="true">
          <UiIcon name="podcast" />
        </span>
        <span class="dashboard-smart-radio-tile__meta">
          <span class="dashboard-smart-radio-tile__title">{t("podcasts.allTitle")}</span>
          <span class="podcast-card__tile-sub">{t("podcasts.allHint")}</span>
        </span>
      </button>
    </div>
  {/if}
</Panel>

<style>
  .podcast-card__error {
    margin: 0;
    color: color-mix(in srgb, var(--rk-danger) 70%, var(--rk-ink));
    font-size: var(--rk-fs-sm);
  }

  /* —— One source —— */
  .podcast-card__single {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--rk-space-lg, 1rem);
    align-items: center;
  }

  @media (min-width: 1000px) {
    .podcast-card__single:not(.podcast-card__single--alone) {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    }
  }

  .podcast-feature {
    display: grid;
    grid-template-columns: 8.5rem minmax(0, 1fr);
    gap: var(--rk-space-lg, 1rem);
    align-items: center;
    min-width: 0;
  }

  .podcast-feature__art {
    position: relative;
    width: 8.5rem;
    height: 8.5rem;
    padding: 0;
    border: 0;
    border-radius: var(--rk-radius-lg);
    overflow: hidden;
    cursor: pointer;
    background: var(--rk-surface-3);
    isolation: isolate;
  }

  .podcast-feature.is-active .podcast-feature__art {
    box-shadow: 0 0 0 2px var(--rk-accent);
  }

  .podcast-feature__art :global(.rk-cover.podcast-feature__cover) {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .podcast-feature__glyph {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-items: center;
    color: #fff;
    background: rgba(0, 0, 0, 0.22);
    transition: background 0.14s ease;
  }

  .podcast-feature__art:hover .podcast-feature__glyph {
    background: rgba(0, 0, 0, 0.4);
  }

  .podcast-feature__glyph :global(:is(svg, .ui-ic)) {
    width: 2.2rem;
    height: 2.2rem;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45));
  }

  .podcast-feature__text {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .podcast-feature__source {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .podcast-feature__title {
    margin: 0;
    font-size: var(--rk-fs-lg, 1.2rem);
    font-weight: 750;
    line-height: 1.2;
    letter-spacing: -0.015em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .podcast-feature__meta {
    margin: 0 0 0.35rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 0.45rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    font-variant-numeric: tabular-nums;
  }

  .podcast-feature__meta > span:not(.podcast-feature__new) + span:not(.podcast-feature__new)::before {
    content: "·";
    margin-right: 0.45rem;
  }

  .podcast-feature__new,
  .podcast-card__new {
    padding: 0.06rem 0.42rem;
    border-radius: var(--rk-radius-sm, 6px);
    font-size: var(--rk-fs-1, 0.68rem);
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rk-accent-ink, #fff);
    background: var(--rk-accent);
  }

  .podcast-feature__text :global(svg) {
    width: 1.05rem;
    height: 1.05rem;
  }

  .podcast-card__rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-sm, 0.5rem);
    container: track-list / inline-size;
  }

  .podcast-card__live-one {
    width: 11rem;
  }

  /* —— Several sources: one tile each, scrolling sideways —— */
  .podcast-card__strip {
    display: grid;
    grid-auto-flow: column;
    /* Fill the card like "Ascolto veloce"; past --pod-cols tiles it scrolls. */
    --pod-gap: 0.85rem;
    grid-auto-columns: max(
      8.75rem,
      calc((100% - (var(--pod-cols, 6) - 1) * var(--pod-gap)) / var(--pod-cols, 6))
    );
    column-gap: var(--pod-gap);
    gap: 1rem 0.85rem;
    overflow-x: auto;
    padding-bottom: 0.35rem;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }

  .podcast-card__slot {
    scroll-snap-align: start;
    min-width: 0;
  }

  .podcast-card__all {
    display: grid;
    place-items: center;
    color: var(--rk-accent-2, var(--rk-accent));
  }

  .podcast-card__all :global(.ui-ic) {
    width: 2.2rem;
    height: 2.2rem;
  }

  .podcast-card__new {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 3;
  }

  .podcast-card__tile-title {
    font-size: var(--rk-fs-sm);
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }

  .podcast-card__tile-sub {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 599.98px) {
    .podcast-feature {
      grid-template-columns: 6.5rem minmax(0, 1fr);
      gap: 0.85rem;
    }

    .podcast-feature__art {
      width: 6.5rem;
      height: 6.5rem;
    }

    .podcast-feature__title {
      font-size: var(--rk-fs-md, 1rem);
    }

    .podcast-card__strip {
      grid-auto-columns: 8.75rem;
    }
  }
</style>
