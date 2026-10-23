<script lang="ts">
  /**
   * Dashboard: hero, account KPIs, quick listen, genre/mood mix, Nebula
   * preview, recently updated albums, favourites, library quality — in the
   * legacy order. Cards live in `components/views/dashboard/`.
   */
  import { untrack } from "svelte";
  import { Button, EmptyState, HeroCard, Metric, Panel } from "@rekord/ui";
  import MediaGrid from "../components/MediaGrid.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import DashboardNebulaCard from "../components/nebula/DashboardNebulaCard.svelte";
  import { features } from "../lib/features.svelte";
  import DashboardMixCard from "../components/views/dashboard/DashboardMixCard.svelte";
  import DashboardQualityCard from "../components/views/dashboard/DashboardQualityCard.svelte";
  import DashboardRadioCard from "../components/views/dashboard/DashboardRadioCard.svelte";
  import LibraryQualityDialog from "../components/views/dashboard/LibraryQualityDialog.svelte";
  import {
    libraryCounts,
    qualityCounts,
    recentlyUpdatedAlbums,
    statsArePerAccount,
    type AccountStats,
  } from "../components/views/dashboard/dashboardStats";
  import { api, coverUrlFor, type Track } from "../lib/api";
  import { fmtNumber, t, tp } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { prefsRevision } from "../lib/prefsRevision.svelte";
  import { session } from "../lib/session.svelte";
  import { describeError, toasts } from "../lib/toasts.svelte";
  import { qualityTotal, type QualityIssue } from "../lib/libraryQuality";
  import { albumHasAlbumMeta, trackHasFileMeta, trackYear } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";
  import { hubModules } from "../lib/hubModules.svelte";

  /** Optional module card: its code is fetched only when the hub has it on. */
  const loadPodcastsCard = () => import("../components/podcasts/DashboardPodcastsCard.svelte");

  /** Catalog / album index load failure (the cards below need them). */
  let loadError = $state<string | null>(null);
  let loading = $state(true);

  const stats = $derived<AccountStats | null>(session.stats);
  /** The bound account's catalog and album index are in (they may be empty). */
  const catalogReady = $derived(
    session.catalogLoaded && (session.allAlbums.length > 0 || session.catalogTracks.length === 0),
  );

  async function loadDashboardData() {
    loading = true;
    loadError = null;
    try {
      await Promise.all([
        session.ensureCatalogTracks(),
        session.allAlbums.length ? Promise.resolve() : session.loadAllAlbums(),
        session.loadStats().catch(() => undefined),
      ]);
    } catch (e) {
      loadError = describeError(e);
    } finally {
      loading = false;
    }
  }

  // Runs again after an account switch (the session drops the old account's
  // lists). Loads are single-flight per account in the session, so this and
  // the boot's own refresh share one request.
  $effect(() => {
    if (!session.activeAccountId) return;
    untrack(() => void loadDashboardData());
  });

  const counts = $derived(libraryCounts(stats, session.catalogTracks, catalogReady));
  const quality = $derived(
    qualityCounts(stats, session.allAlbums, session.catalogTracks, catalogReady),
  );
  const qualitySum = $derived(quality ? qualityTotal(quality) : null);

  /** "Da sistemare" dialog: the issue shown, null when closed. */
  let qualityTab = $state<QualityIssue | null>(null);

  function openQuality(issue?: QualityIssue) {
    if (issue) {
      qualityTab = issue;
      return;
    }
    // From the tile: the first issue that has something to fix.
    const q = quality;
    qualityTab =
      !q?.albumsWithoutCover && q?.albumsWithoutMeta
        ? "albums-without-meta"
        : !q?.albumsWithoutCover && q?.tracksWithoutMeta
          ? "tracks-without-meta"
          : "albums-without-cover";
  }

  /**
   * Nothing in this account's library. With a hub ≥ 5.2 we can tell an empty
   * selection (catalog has tracks) from an empty index.
   */
  const emptyLibrary = $derived(counts != null && counts.tracks === 0 && !loadError);
  const hubHasTracks = $derived(
    statsArePerAccount(stats) ? (stats?.catalog_track_count ?? 0) > 0 : null,
  );

  const playCounts = $derived.by(() => {
    void prefsRevision.playCounts;
    return loadUserPrefs().playCounts;
  });
  const exclusionsRev = $derived(prefsRevision.exclusions);

  function playsOf(tr: Track): number {
    return playCounts[tr.rel_path] ?? playCounts[String(tr.id)] ?? 0;
  }

  const topFavorites = $derived(
    [...session.favorites]
      .sort((a, b) => playsOf(b) - playsOf(a) || a.title.localeCompare(b.title))
      .slice(0, 5),
  );

  /** Per-album aggregates for the "recent albums" grid, one pass over the catalog. */
  const albumAgg = $derived.by(() => {
    void exclusionsRev;
    const excludedPaths = player.getExcludedRelPaths();
    const byAlbum = new Map<number, { missingMeta: number; excludedPaths: number }>();
    for (const tr of session.catalogTracks) {
      if (tr.album_id == null) continue;
      let cur = byAlbum.get(tr.album_id);
      if (!cur) {
        cur = { missingMeta: 0, excludedPaths: 0 };
        byAlbum.set(tr.album_id, cur);
      }
      if (!trackHasFileMeta(tr)) cur.missingMeta += 1;
      if (excludedPaths.has(tr.rel_path)) cur.excludedPaths += 1;
    }
    const favByAlbum = new Map<number, number>();
    for (const f of session.favorites) {
      if (f.album_id != null) favByAlbum.set(f.album_id, (favByAlbum.get(f.album_id) ?? 0) + 1);
    }
    return { byAlbum, favByAlbum };
  });

  const recentAlbumItems = $derived.by(() => {
    void exclusionsRev;
    return recentlyUpdatedAlbums(session.allAlbums, 12).map((a) => {
      const agg = albumAgg.byAlbum.get(a.id);
      const albumEx = player.isAlbumExcluded(a.id);
      const year = trackYear(null, a);
      const tracksLabel = tp("library.tracksCount", a.track_count);
      return {
        id: a.id,
        title: a.name,
        metaLine: year ? `${tracksLabel} · ${year}` : tracksLabel,
        coverSrc: coverUrlFor(a, 256),
        coverSeed: `${a.artist_name}/${a.name}`,
        favoriteCount: albumAgg.favByAlbum.get(a.id) ?? 0,
        tracksMissingMetaCount: agg?.missingMeta ?? 0,
        genreMissing: !albumHasAlbumMeta(a),
        albumExcluded: albumEx,
        tracksExcludedCount: albumEx ? a.track_count : (agg?.excludedPaths ?? 0),
        loose: a.loose,
      };
    });
  });

  async function openAlbum(id: number | string) {
    try {
      const album = await api.album(Number(id));
      if (album.artist_id != null) {
        const artist = await api.artist(album.artist_id);
        await session.openArtist(artist);
      }
      await session.openAlbum(album);
    } catch (e) {
      toasts.fail(e);
    }
  }

  const heroListenPaused = $derived(Boolean(session.current) && !session.playing);
  const heroStartsShuffle = $derived(!session.current);

  function openListen() {
    session.studioPane = "listen";
    session.navigate("studio");
  }

  function heroListen() {
    if (!session.current) {
      void session.shuffleLibrary().then(openListen);
      return;
    }
    if (!session.playing) void player.toggle();
    openListen();
  }

  function heroLibraryShuffle() {
    void session.shuffleLibrary().then(openListen);
  }

  function openDiscover() {
    session.studioPane = "catalog";
    session.navigate("studio");
  }

  function fmtCount(n: number | undefined) {
    return n == null ? null : fmtNumber(n);
  }
</script>

{#snippet podcastsCard()}
  {#if hubModules.podcasts}
    {#await loadPodcastsCard() then mod}
      <mod.default />
    {/await}
  {/if}
{/snippet}

<div class="view-page dashboard-page">
  <HeroCard title={t("page.dashboard.title")} eyebrow="RE-KORD">
    <Button class="dashboard-hero-listen-btn" disabled={emptyLibrary && !session.current} onclick={heroListen}>
      {#if heroStartsShuffle}
        <UiIcon name="shuffle" class="dashboard-hero-listen-btn__ic" />
      {:else}
        <UiIcon name="play" class="dashboard-hero-listen-btn__ic" />
      {/if}
      {heroListenPaused ? t("dashboard.heroResume") : t("dashboard.heroListen")}
    </Button>
    {#if session.current && !emptyLibrary}
      <Button
        variant="ghost"
        class="dashboard-hero-shuffle-btn"
        title={t("dashboard.heroShuffle")}
        aria-label={t("dashboard.heroShuffle")}
        onclick={heroLibraryShuffle}
      >
        <UiIcon name="shuffle" class="dashboard-hero-shuffle-btn__ic" />
      </Button>
    {/if}
  </HeroCard>

  <div class="metrics" aria-busy={counts == null}>
    <Metric label={t("dashboard.metricArtists")} value={fmtCount(counts?.artists)} loading={counts == null} />
    <Metric label={t("dashboard.metricAlbums")} value={fmtCount(counts?.albums)} loading={counts == null} />
    <Metric label={t("dashboard.metricTracks")} value={fmtCount(counts?.tracks)} loading={counts == null} />
    <Metric
      label={t("dashboard.metricQuality")}
      value={qualitySum == null ? null : fmtNumber(qualitySum)}
      tone={qualitySum ? "warning" : qualitySum === 0 ? "success" : "default"}
      loading={qualitySum == null}
      onclick={catalogReady ? () => openQuality() : undefined}
    />
  </div>

  {#if loadError}
    <div class="dashboard-load-error" role="alert">
      <span>{t("dashboard.loadError", { error: loadError })}</span>
      <button type="button" class="text-btn" disabled={loading} onclick={() => void loadDashboardData()}>
        {t("library.retry")}
      </button>
    </div>
  {/if}

  {#if emptyLibrary}
    <Panel class="session-card dashboard-session-card dashboard-empty-card">
      <EmptyState
        title={t("dashboard.emptyTitle")}
        body={hubHasTracks === false ? t("dashboard.emptyBodyHub") : t("dashboard.emptyBodySelection")}
      >
        {#snippet icon()}<UiIcon name="disc" />{/snippet}
        {#snippet action()}
          {#if hubHasTracks === false}
            <Button onclick={() => session.openSettings({ section: "Libreria" })}>
              <UiIcon name="settings" />
              {t("dashboard.emptyOpenSettings")}
            </Button>
          {:else}
            <Button onclick={openDiscover}>
              <UiIcon name="sparkle" />
              {t("dashboard.emptyChooseLibrary")}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
    </Panel>
    {@render podcastsCard()}
  {:else}
    <div class="dashboard-page__main">
      <DashboardRadioCard {loading} />
      <DashboardMixCard {loading} />
      {@render podcastsCard()}
      {#if features.nebula}
        <DashboardNebulaCard tracks={session.catalogTracks} />
      {/if}

      <Panel class="session-card dashboard-session-card dashboard-page__full dashboard-page__tile">
        <header class="section-head section-head--page-toolbar">
          <SectionHeadLead eyebrow={t("dashboard.recentEyebrow")} title={t("dashboard.recentTitle")}>
            <UiIcon name="sync" />
          </SectionHeadLead>
          <div class="section-head__tools">
            <button type="button" class="text-btn" onclick={() => session.navigate("library")}>
              {t("dashboard.openLibrary")}
            </button>
          </div>
        </header>
        <MediaGrid
          kind="album"
          dashboard
          items={recentAlbumItems}
          emptyMessage={loading ? t("dashboard.loading") : t("dashboard.recentEmpty")}
          onselect={(id) => void openAlbum(id)}
        />
      </Panel>

      <Panel class="session-card dashboard-session-card dashboard-page__tile">
        <header class="section-head section-head--page-toolbar">
          <SectionHeadLead eyebrow={t("dashboard.favEyebrow")} title={t("dashboard.favTitle")}>
            <UiIcon name="favorite" />
          </SectionHeadLead>
          <div class="section-head__tools">
            <button type="button" class="text-btn" onclick={() => session.navigate("favorites")}>
              {t("dashboard.favAll")}
            </button>
          </div>
        </header>
        <div class="tight">
          <TrackList
            tracks={topFavorites}
            favoriteIds={session.favoriteIds}
            playlistOptions={session.playlistOptions}
            activeTrackId={session.current?.id ?? null}
            onplay={(track) => void session.playGlobalRadio(track)}
            ontoggleFavorite={(track) => void session.toggleFavorite(track)}
            onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
          >
            {#snippet empty()}
              <EmptyState variant="inline" title={t("dashboard.favEmpty")} body={t("dashboard.favEmptyBody")}>
                {#snippet icon()}<UiIcon name="favorite" />{/snippet}
                {#snippet action()}
                  <Button variant="ghost" onclick={() => session.navigate("library")}>{t("dashboard.openLibrary")}</Button>
                {/snippet}
              </EmptyState>
            {/snippet}
          </TrackList>
        </div>
      </Panel>

      <DashboardQualityCard counts={quality} onopen={catalogReady ? openQuality : undefined} />
    </div>
  {/if}
</div>

{#if qualityTab}
  <LibraryQualityDialog
    initialTab={qualityTab}
    onclose={() => (qualityTab = null)}
    onopenalbum={(id) => void openAlbum(id)}
  />
{/if}

<style>
  :global(.dashboard-hero-listen-btn) {
    --dashboard-hero-btn-h: 2.75rem;
    min-height: var(--dashboard-hero-btn-h);
    padding: 0 1.4rem;
    font-size: var(--rk-fs-base);
    box-sizing: border-box;
  }

  :global(.dashboard-hero-listen-btn__ic) {
    width: 1.2rem;
    height: 1.2rem;
    flex-shrink: 0;
  }

  :global(.dashboard-hero-shuffle-btn) {
    width: var(--dashboard-hero-btn-h, 2.75rem);
    height: var(--dashboard-hero-btn-h, 2.75rem);
    min-width: var(--dashboard-hero-btn-h, 2.75rem);
    min-height: var(--dashboard-hero-btn-h, 2.75rem);
    padding: 0;
    flex: 0 0 auto;
  }

  :global(.dashboard-hero-shuffle-btn__ic) {
    width: 1.2rem;
    height: 1.2rem;
    flex-shrink: 0;
  }

  /* Cancels the UI components' margin: the vertical rhythm is only the page's gap. */
  .dashboard-page > :global(.rk-hero),
  .dashboard-page__main > :global(.rk-panel) {
    margin-bottom: 0;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.55rem;
    margin: 0;
  }

  .dashboard-page__main {
    display: grid;
    gap: var(--rk-section-gap);
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    align-items: start;
  }

  .dashboard-page__main > :global(*) {
    min-width: 0;
  }

  .dashboard-page__main > :global(.dashboard-page__full) {
    grid-column: 1 / -1;
  }

  @media (min-width: 720px) {
    .dashboard-page__main {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .dashboard-load-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid color-mix(in srgb, var(--rk-danger) 45%, var(--rk-line));
    font-size: var(--rk-fs-sm);
  }

  .tight {
    padding: 0;
    margin: 0;
  }

  /* Mobile: 2x2 KPIs (legacy), never one per row. */
  @media (max-width: 999.98px) {
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
