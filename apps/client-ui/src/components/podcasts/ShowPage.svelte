<script lang="ts">
  /**
   * One source as a show page, in the album-page layout: a hero with the
   * large artwork, type tag, name, "updated" line and "Ascolta l'ultima",
   * then the episodes as track rows. A live station gets a radio tile.
   */
  import { Button, CoverArt, Skeleton } from "@rekord/ui";
  import { translateHubError } from "../../lib/api/http";
  import { apiUrl } from "../../lib/config";
  import { fmtRelative, t, tp } from "../../lib/i18n.svelte";
  import { player } from "../../lib/player";
  import { episodesFor, type PodcastSource } from "../../lib/podcastModel";
  import { podcasts } from "../../lib/podcasts/store.svelte";
  import { session } from "../../lib/session.svelte";
  import SectionHeadLead from "../SectionHeadLead.svelte";
  import UiIcon from "../icons/UiIcon.svelte";
  import EpisodeRow from "./EpisodeRow.svelte";
  import LiveTile from "./LiveTile.svelte";

  let { source }: { source: PodcastSource } = $props();

  const art = $derived(source.hasArt ? apiUrl(`/api/v1/podcasts/art/${source.id}/_`) : null);
  const episodes = $derived(episodesFor(source));
  const latest = $derived(episodes[0] ?? null);
  const errorText = $derived(source.error ? translateHubError(source.error) : "");
  const latestProg = $derived(latest ? podcasts.progress(source, latest) : null);
  const latestPlaying = $derived.by(() => {
    void session.tick;
    return !!latest && podcasts.isCurrent(source, latest) && session.playing;
  });
  const liveEp = $derived(source.live ? (source.episodes[0] ?? null) : null);
  const livePlaying = $derived.by(() => {
    void session.tick;
    return !!liveEp && podcasts.isCurrent(source, liveEp) && session.playing;
  });
  const totalMinutes = $derived(
    Math.round(episodes.reduce((sum, e) => sum + (e.durationSecs ?? 0), 0) / 60),
  );

  function toggleLive() {
    if (!liveEp) return;
    if (livePlaying) player.pause();
    else podcasts.play(source, liveEp);
  }

  function playLatest() {
    if (!latest) return;
    if (latestPlaying) player.pause();
    else podcasts.play(source, latest);
  }
</script>

<div class="show-page">
  <section class="album-hero rk-surface-card show-hero" class:show-hero--live={source.live}>
    <div class="show-hero__cover">
      {#if source.live}
        <LiveTile {source} large />
      {:else}
        <CoverArt kind="album" class="show-hero__art" title={source.name} src={art} size="xl" loading="eager" />
      {/if}
    </div>

    <div class="show-hero__toprow">
      <div class="show-hero__tags">
        {#if source.live}
          <span class="show-hero__live">LIVE</span>
        {/if}
        <p class="rk-eyebrow">{t(`podcasts.kind.${source.kind}`)}</p>
      </div>
      <div class="show-hero__actions">
        {#if source.live}
          <Button class="show-hero__play" disabled={!liveEp} onclick={toggleLive}>
            <UiIcon name={livePlaying ? "pause" : "play"} />
            {t("podcasts.listenLive")}
          </Button>
        {:else}
          <Button class="show-hero__play" disabled={!latest} onclick={playLatest}>
            <UiIcon name={latestPlaying ? "pause" : "play"} />
            {latestProg?.resumeAt ? t("podcasts.resumeLatest") : t("podcasts.listenLatest")}
          </Button>
          <Button
            variant="ghost"
            disabled={podcasts.loading}
            title={t("podcasts.refresh")}
            aria-label={t("podcasts.refresh")}
            onclick={() => void podcasts.load({ force: true })}
          >
            <UiIcon name="sync" />
          </Button>
        {/if}
      </div>
    </div>

    <h1 class="show-hero__title">{source.name}</h1>

    <div class="show-hero__info">
      <p class="show-hero__meta">
        {#if source.live}
          <span>{t("podcasts.liveHint")}</span>
        {:else}
          {#if source.fetchedAt}<span>{t("podcasts.updated", { when: fmtRelative(source.fetchedAt) })}</span>{/if}
          {#if episodes.length}<span>{tp("podcasts.episodesCount", episodes.length)}</span>{/if}
          {#if totalMinutes > 0}<span>{t("library.albumMinutes", { n: totalMinutes })}</span>{/if}
        {/if}
      </p>
      {#if latest && !source.live}
        <p class="show-hero__latest">
          <span class="show-hero__latest-k">{t("podcasts.latestEpisode")}</span>
          <span class="show-hero__latest-v">{latest.title}</span>
          {#if latest.publishedAt}<span class="show-hero__latest-when">{fmtRelative(latest.publishedAt)}</span>{/if}
        </p>
      {/if}
      {#if errorText}
        <p class="show-hero__error" role="status">
          {episodes.length ? t("podcasts.staleError", { error: errorText }) : errorText}
        </p>
      {/if}
    </div>
  </section>

  {#if !source.live}
    <section class="album-hero__tracks rk-surface-card show-episodes">
      <div class="show-episodes__head">
        <SectionHeadLead eyebrow={t("podcasts.episodesHead")} title={tp("podcasts.episodesCount", episodes.length)}>
          <UiIcon name="podcast" />
        </SectionHeadLead>
      </div>
      {#if episodes.length}
        <ul class="show-episodes__list">
          {#each episodes as ep, i (ep.key)}
            <EpisodeRow {source} {ep} newest={i === 0} />
          {/each}
        </ul>
      {:else if podcasts.loading}
        <Skeleton variant="row" count={3} />
      {:else}
        <p class="show-episodes__empty">{t("podcasts.noEpisodes")}</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .show-page {
    display: grid;
    gap: var(--rk-section-gap, 1rem);
    min-width: 0;
  }

  /* Album hero: artwork spanning the left column; tags + actions, title,
     meta on the right. */
  .show-hero {
    display: grid;
    grid-template-columns: clamp(140px, 16vw, 200px) minmax(0, 1fr);
    grid-template-rows: auto auto 1fr;
    gap: 0.9rem 1.5rem;
    align-items: start;
    padding: var(--rk-space-lg, 1.25rem);
  }

  .show-hero__cover {
    grid-column: 1;
    grid-row: 1 / -1;
    line-height: 0;
    width: clamp(140px, 16vw, 200px);
  }

  .show-hero__cover :global(.rk-cover.show-hero__art) {
    width: clamp(140px, 16vw, 200px);
    height: clamp(140px, 16vw, 200px);
    --cover-initials: 3rem;
  }

  .show-hero--live .show-hero__cover :global(:is(.live-tile__meta, .live-tile__pill)) {
    display: none;
  }

  .show-hero__latest {
    margin: 0.35rem 0 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem 0.5rem;
    padding: 0.55rem 0.75rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-3) 45%, transparent);
    font-size: var(--rk-fs-sm);
    max-width: 40rem;
  }

  .show-hero__latest-k {
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .show-hero__latest-v {
    font-weight: 700;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .show-hero__latest-when {
    color: var(--rk-muted);
  }

  .show-hero__toprow {
    grid-column: 2;
    grid-row: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.6rem 1rem;
    min-width: 0;
  }

  .show-hero__tags {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: var(--rk-control-h, 2.5rem);
  }

  .show-hero__tags :global(.rk-eyebrow) {
    margin: 0;
  }

  .show-hero__live {
    padding: 0.12rem 0.45rem;
    border-radius: var(--rk-radius-sm, 6px);
    background: var(--rk-danger-solid, #d93a3f);
    color: #fff;
    font-size: var(--rk-fs-1, 0.68rem);
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .show-hero__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .show-hero__actions :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }

  .show-hero__title {
    grid-column: 2;
    grid-row: 2;
    margin: 0;
    font-size: clamp(1.5rem, 3vw, 2rem);
    line-height: 1.15;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .show-hero__info {
    grid-column: 2;
    grid-row: 3;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .show-hero__meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
  }

  .show-hero__meta > :not(:first-child)::before {
    content: "·";
    margin: 0 0.45rem;
  }

  .show-hero__error {
    margin: 0;
    padding: 0.45rem 0.7rem;
    border-radius: var(--rk-radius);
    border: 1px solid color-mix(in srgb, var(--rk-danger) 40%, var(--rk-line));
    font-size: var(--rk-fs-sm);
    color: color-mix(in srgb, var(--rk-danger) 70%, var(--rk-ink));
  }

  .show-episodes__head {
    margin: 0 0 var(--rk-space-md, 0.85rem);
  }

  .show-episodes__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-lg);
    container: track-list / inline-size;
  }

  .show-episodes__empty {
    margin: 0;
    color: var(--rk-muted);
  }

  /* Phones: stacked and centred, full-width primary action (album hero). */
  @media (max-width: 719.98px) {
    .show-hero {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: none;
      justify-items: center;
      gap: 0.85rem;
      padding: 1rem;
    }

    .show-hero__cover,
    .show-hero__toprow,
    .show-hero__title,
    .show-hero__info {
      grid-column: 1;
      grid-row: auto;
    }

    .show-hero__cover,
    .show-hero__cover :global(.rk-cover.show-hero__art) {
      width: min(56vw, 220px);
      height: auto;
    }

    .show-hero__cover :global(.rk-cover.show-hero__art) {
      height: min(56vw, 220px);
    }

    .show-hero__title,
    .show-hero__info {
      text-align: center;
      justify-items: center;
      width: 100%;
    }

    .show-hero__meta {
      justify-content: center;
    }

    /* Cover, tag, title, meta, then the actions. */
    .show-hero__toprow {
      display: contents;
    }

    .show-hero__tags {
      order: 1;
      min-height: 0;
    }

    .show-hero__title {
      order: 2;
    }

    .show-hero__info {
      order: 3;
    }

    .show-hero__actions {
      order: 4;
      width: 100%;
      justify-content: center;
    }

    .show-hero__actions :global(.show-hero__play) {
      flex: 1 1 auto;
      justify-content: center;
    }
  }
</style>
