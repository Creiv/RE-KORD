<script lang="ts">
  /**
   * Podcast e notizie. One source: its show page. Several: artwork chips to
   * switch, "Ultimi" (newest across sources) first; the choice is remembered
   * on this device. Its own chunk, fetched only when the hub has the module on.
   */
  import { onMount } from "svelte";
  import { Button, CoverArt, EmptyState, Skeleton } from "@rekord/ui";
  import LatestOverview from "../components/podcasts/LatestOverview.svelte";
  import ShowPage from "../components/podcasts/ShowPage.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { apiUrl } from "../lib/config";
  import { t } from "../lib/i18n.svelte";
  import { resolveTab, visibleSources } from "../lib/podcastModel";
  import { podcasts } from "../lib/podcasts/store.svelte";
  import { session } from "../lib/session.svelte";

  const TAB_KEY = "rekord.podcasts.tab";

  function readTab(): string | null {
    try {
      return localStorage.getItem(TAB_KEY);
    } catch {
      return null;
    }
  }

  let stored = $state<string | null>(readTab());

  function pick(tab: string) {
    stored = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* private mode: kept for this visit */
    }
  }

  onMount(() => {
    void podcasts.load();
  });

  const sources = $derived(visibleSources(podcasts.sources));
  const tab = $derived(resolveTab(stored, sources));
  const selected = $derived(tab === "latest" ? null : (sources.find((s) => String(s.id) === tab) ?? null));
</script>

<div class="view-page podcasts-page">
  {#if !podcasts.loaded && podcasts.loading}
    <section class="album-hero rk-surface-card podcasts-page__state">
      <Skeleton variant="row" count={5} label={t("podcasts.loading")} />
    </section>
  {:else if podcasts.error && !podcasts.sources.length}
    <section class="album-hero rk-surface-card podcasts-page__state">
      <EmptyState title={t("podcasts.loadFailed")} body={podcasts.error}>
        {#snippet icon()}<UiIcon name="podcast" />{/snippet}
        {#snippet action()}
          <Button onclick={() => void podcasts.load({ force: true })}>{t("library.retry")}</Button>
        {/snippet}
      </EmptyState>
    </section>
  {:else if !sources.length}
    <section class="album-hero rk-surface-card podcasts-page__state">
      <EmptyState title={t("podcasts.emptyTitle")} body={t("podcasts.emptyBody")}>
        {#snippet icon()}<UiIcon name="podcast" />{/snippet}
        {#snippet action()}
          <a class="text-btn" href={session.hubPanelUrl} target="_blank" rel="noopener noreferrer">
            {t("podcasts.openAdmin")}
          </a>
        {/snippet}
      </EmptyState>
    </section>
  {:else}
    {#if sources.length > 1}
      <nav class="rk-surface-card podcasts-tabs" aria-label={t("podcasts.sourcesAria")}>
        <div class="podcasts-tabs__scroll rk-scroll" role="tablist">
          <button
            type="button"
            role="tab"
            class="podcasts-chip"
            class:is-active={tab === "latest"}
            aria-selected={tab === "latest"}
            onclick={() => pick("latest")}
          >
            <span class="podcasts-chip__ic" aria-hidden="true"><UiIcon name="history" /></span>
            <span class="podcasts-chip__label">{t("podcasts.latestTab")}</span>
          </button>
          {#each sources as source (source.id)}
            <button
              type="button"
              role="tab"
              class="podcasts-chip"
              class:is-active={tab === String(source.id)}
              aria-selected={tab === String(source.id)}
              title={source.name}
              onclick={() => pick(String(source.id))}
            >
              <CoverArt
                kind="album"
                class="podcasts-chip__art"
                title={source.name}
                src={source.hasArt ? apiUrl(`/api/v1/podcasts/art/${source.id}/_`) : null}
                size="xs"
              />
              <span class="podcasts-chip__label">{source.name}</span>
              {#if source.live}<span class="podcasts-chip__live">LIVE</span>{/if}
            </button>
          {/each}
        </div>
        {#if !selected}
          <div class="podcasts-tabs__tools">
            <Button
              variant="ghost"
              class="podcasts-tabs__refresh"
              disabled={podcasts.loading}
              title={t("podcasts.refresh")}
              aria-label={t("podcasts.refresh")}
              onclick={() => void podcasts.load({ force: true })}
            >
              <UiIcon name="sync" />
            </Button>
          </div>
        {/if}
      </nav>
    {/if}

    {#if selected}
      {#key selected.id}
        <ShowPage source={selected} />
      {/key}
    {:else}
      <LatestOverview {sources} />
    {/if}
  {/if}
</div>

<style>
  .podcasts-page {
    display: flex;
    flex-direction: column;
    gap: var(--rk-section-gap);
    min-width: 0;
  }

  .podcasts-page__state {
    padding: var(--rk-space-lg);
  }

  .podcasts-tabs {
    display: flex;
    align-items: center;
    gap: var(--rk-space-md, 0.75rem);
    padding: 0.6rem var(--rk-space-lg, 1rem);
    min-width: 0;
  }

  .podcasts-tabs__scroll {
    display: flex;
    gap: 0.5rem;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: thin;
    padding: 0.15rem 0.05rem;
    scroll-snap-type: x proximity;
  }

  .podcasts-tabs__tools {
    display: flex;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .podcasts-tabs__tools :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
  }

  .podcasts-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 15rem;
    min-height: 2.5rem;
    padding: 0.3rem 0.85rem 0.3rem 0.3rem;
    border-radius: var(--rk-radius-lg, 10px);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-3) 50%, transparent);
    color: var(--rk-ink);
    font: inherit;
    font-size: var(--rk-fs-sm);
    font-weight: 650;
    cursor: pointer;
    scroll-snap-align: start;
    transition:
      border-color 0.14s ease,
      background 0.14s ease;
  }

  .podcasts-chip:hover {
    border-color: color-mix(in srgb, var(--rk-accent) 35%, var(--rk-line));
  }

  .podcasts-chip.is-active {
    border-color: color-mix(in srgb, var(--rk-accent) 60%, var(--rk-line));
    background: color-mix(in srgb, var(--rk-accent) 14%, var(--rk-surface-2));
  }

  .podcasts-chip :global(.rk-cover.podcasts-chip__art) {
    width: 1.9rem;
    height: 1.9rem;
    flex: 0 0 auto;
    border-radius: var(--rk-radius-sm, 6px);
  }

  .podcasts-chip__ic {
    display: grid;
    place-items: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: var(--rk-radius-sm, 6px);
    background: var(--rk-accent2-soft, var(--rk-surface-3));
    color: var(--rk-accent-2, var(--rk-accent));
  }

  .podcasts-chip__ic :global(.ui-ic) {
    width: 1.05rem;
    height: 1.05rem;
  }

  .podcasts-chip__label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .podcasts-chip__live {
    flex: 0 0 auto;
    font-size: var(--rk-fs-1, 0.68rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    color: var(--rk-danger, #e5484d);
  }

  @media (max-width: 719.98px) {
    .podcasts-tabs {
      padding: 0.5rem 0.6rem;
    }

    .podcasts-chip {
      max-width: 12rem;
    }
  }
</style>
