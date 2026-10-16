<script lang="ts">
  /**
   * Statistics: top 3 tracks / artists / albums / genres for the chosen
   * measure (plays, favourites, shuffle blocks, Plectr records) and the
   * overview KPIs. Plectr records are read-only here (`lib/plectr/*`, K4).
   */
  import { onMount } from "svelte";
  import { Button, CoverArt, Metric, Panel, Skeleton } from "@rekord/ui";
  import PageToolbar from "../components/PageToolbar.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { api, coverUrlFor, type Album, type Artist, type Track } from "../lib/api";
  import { buildArtistCoverAlbumMap } from "../lib/artistCover";
  import { normalizeGenreKey, trackGenres } from "../lib/genres";
  import { player } from "../lib/player";
  import { prefsRevision } from "../lib/prefsRevision.svelte";
  import { fmtNumber, i18n, t, tp } from "../lib/i18n.svelte";
  import { session } from "../lib/session.svelte";
  import { openPlectr } from "../lib/plectr/nav.svelte";
  import { plectrRecords } from "../lib/plectr/persist.svelte";
  import { countPlectrTracksPlayed, lookupByRelPathAliases } from "../lib/plectr/records";

  type MetricMode = "plays" | "favorites" | "blocked" | "plectr";

  const TOP_N = 3;
  const METRIC_TABS = $derived([
    { id: "plays", label: t("page.statistics.tab.plays") },
    { id: "favorites", label: t("page.statistics.tab.favorites") },
    { id: "blocked", label: t("page.statistics.tab.blocked") },
    { id: "plectr", label: t("stats.tab.plectr") },
  ]);

  let metricMode = $state<MetricMode>("plays");
  let ready = $state(false);
  let loadError = $state(false);

  const plectrBests = $derived(plectrRecords.store.bests);

  const fmtN = (n: number) => fmtNumber(n);

  const modeLabel = $derived(METRIC_TABS.find((tab) => tab.id === metricMode)?.label ?? "");

  const tracks = $derived(session.catalogTracks);
  const albums = $derived(session.allAlbums);
  const artists = $derived(session.artists);

  const artistCoverById = $derived(buildArtistCoverAlbumMap(artists, albums));

  const albumById = $derived.by(() => {
    const m = new Map<number, Album>();
    for (const a of albums) m.set(a.id, a);
    return m;
  });

  const artistById = $derived.by(() => {
    const m = new Map<number, Artist>();
    for (const a of artists) m.set(a.id, a);
    return m;
  });

  const scoreByTrackId = $derived.by(() => {
    void prefsRevision.playCounts;
    void prefsRevision.exclusions;
    void session.favorites;
    const counts = player.allPlayCounts();
    const favIds = session.favoriteIds;
    const score = new Map<number, number>();
    for (const tr of tracks) {
      if (metricMode === "plays") {
        score.set(tr.id, counts[tr.rel_path] ?? counts[String(tr.id)] ?? 0);
      } else if (metricMode === "favorites") {
        score.set(tr.id, favIds.has(tr.id) ? 1 : 0);
      } else if (metricMode === "blocked") {
        score.set(tr.id, player.isTrackExcluded(tr) ? 1 : 0);
      } else if (metricMode === "plectr") {
        const best = lookupByRelPathAliases(plectrBests, tr.rel_path);
        score.set(tr.id, best && best.score > 0 ? best.score : 0);
      } else {
        score.set(tr.id, 0);
      }
    }
    return score;
  });

  type RankTrack = { tr: Track; n: number };
  type RankArtist = { id: number | null; name: string; n: number };
  type RankAlbum = { al: Album; n: number };
  type RankGenre = { key: string; label: string; n: number };

  const rankings = $derived.by(() => {
    const score = scoreByTrackId;
    const trackRows: RankTrack[] = tracks
      .map((tr) => ({ tr, n: score.get(tr.id) ?? 0 }))
      .filter((x) => x.n > 0)
      .sort(
        (a, b) =>
          b.n - a.n ||
          a.tr.title.localeCompare(b.tr.title, i18n.sortLocale, { numeric: true }) ||
          a.tr.id - b.tr.id,
      );

    const artistMap = new Map<string, RankArtist>();
    for (const tr of tracks) {
      const n = score.get(tr.id) ?? 0;
      if (n <= 0) continue;
      const key = tr.artist_id != null ? `id:${tr.artist_id}` : `name:${tr.artist_name}`;
      const cur = artistMap.get(key) ?? {
        id: tr.artist_id,
        name: tr.artist_name,
        n: 0,
      };
      cur.n += n;
      artistMap.set(key, cur);
    }
    const artistRows = [...artistMap.values()].sort(
      (a, b) =>
        b.n - a.n || a.name.localeCompare(b.name, i18n.sortLocale, { numeric: true }),
    );

    let albumRows: RankAlbum[] = [];
    if (metricMode === "blocked") {
      albumRows = albums
        .map((al) => ({
          al,
          n: player.isAlbumExcluded(al.id) ? 1 : 0,
        }))
        .filter((x) => x.n > 0)
        .sort(
          (a, b) =>
            b.n - a.n ||
            a.al.name.localeCompare(b.al.name, i18n.sortLocale, { numeric: true }),
        );
    } else {
      const albumMap = new Map<number, RankAlbum>();
      const looseMap = new Map<string, RankAlbum>();
      for (const tr of tracks) {
        const n = score.get(tr.id) ?? 0;
        if (n <= 0) continue;
        if (tr.album_id != null) {
          const al = albumById.get(tr.album_id);
          if (!al) continue;
          const cur = albumMap.get(al.id) ?? { al, n: 0 };
          cur.n += n;
          albumMap.set(al.id, cur);
        } else {
          const key = `${tr.artist_name}|||${tr.album_name}`;
          const cur =
            looseMap.get(key) ??
            ({
              al: {
                id: -1,
                name: tr.album_name,
                artist_name: tr.artist_name,
                track_count: 0,
                artist_id: tr.artist_id,
                folder_key: key,
                has_cover: false,
                loose: true,
              },
              n: 0,
            } satisfies RankAlbum);
          cur.n += n;
          looseMap.set(key, cur);
        }
      }
      albumRows = [...albumMap.values(), ...looseMap.values()].sort(
        (a, b) =>
          b.n - a.n ||
          a.al.name.localeCompare(b.al.name, i18n.sortLocale, { numeric: true }),
      );
    }

    // Genres split ("Hip Hop; Pop Rap" scores for both) and normalized by key.
    const genreMap = new Map<string, RankGenre>();
    for (const tr of tracks) {
      const n = score.get(tr.id) ?? 0;
      if (n <= 0) continue;
      const album = tr.album_id != null ? albumById.get(tr.album_id) : null;
      for (const label of trackGenres(tr, album)) {
        const key = normalizeGenreKey(label);
        if (!key) continue;
        const prev = genreMap.get(key);
        if (prev) prev.n += n;
        else genreMap.set(key, { key, label, n });
      }
    }
    const topGenres = [...genreMap.values()]
      .sort(
        (a, b) =>
          b.n - a.n || a.label.localeCompare(b.label, i18n.sortLocale, { numeric: true }),
      )
      .slice(0, TOP_N);

    return {
      topTracks: trackRows.slice(0, TOP_N),
      topArtists: artistRows.slice(0, TOP_N),
      topAlbums: albumRows.slice(0, TOP_N),
      topGenres,
    };
  });

  const overview = $derived.by(() => {
    void prefsRevision.playCounts;
    const counts = player.allPlayCounts();
    let totalScore = 0;
    const touched: Track[] = [];
    for (const tr of tracks) {
      const n = counts[tr.rel_path] ?? counts[String(tr.id)] ?? 0;
      totalScore += n;
      if (n > 0) touched.push(tr);
    }
    const artistsTouched = new Set(touched.map((t) => t.artist_name)).size;
    const albumsTouched = new Set(
      touched.map((t) =>
        t.album_id != null ? `id:${t.album_id}` : `${t.artist_name}/${t.album_name}`,
      ),
    ).size;
    return {
      totalScore,
      tracksWithPlays: touched.length,
      artistsTouched,
      albumsTouched,
    };
  });

  const totalFavorites = $derived(session.favorites.length);
  const totalShuffleBlocks = $derived.by(() => {
    void prefsRevision.exclusions;
    return tracks.filter((tr) => player.isTrackExcluded(tr)).length;
  });
  const totalPlectrTracks = $derived(countPlectrTracksPlayed(plectrBests));

  function formatMetricValue(n: number, relPath?: string): string {
    if (metricMode === "plays") return t("stats.playsCount", { n: fmtN(n) });
    if (metricMode === "favorites") return tp("stats.favoriteCount", n);
    if (metricMode === "plectr") {
      const grade = relPath ? lookupByRelPathAliases(plectrBests, relPath)?.grade : undefined;
      return grade
        ? t("stats.plectrScoreWithGrade", { n: fmtN(n), grade })
        : tp("stats.plectrScore", n);
    }
    return tp("stats.blockedCount", n);
  }

  const emptyMessage = $derived(
    metricMode === "plectr" ? t("stats.rankEmptyPlectr") : t("stats.rankEmpty"),
  );

  async function openTrack(tr: Track) {
    await session.openLibraryForTrack(tr);
  }

  async function openArtistRow(row: RankArtist) {
    if (row.id == null) return;
    const ar = artistById.get(row.id);
    if (ar) {
      await session.openArtist(ar);
      return;
    }
    try {
      await session.openArtist(await api.artist(row.id));
    } catch {
      /* ignore */
    }
  }

  /** Covers of the genre's top albums (by the current measure), for the mosaic. */
  function genreCovers(key: string): (string | null)[] {
    const out: (string | null)[] = [];
    const seen = new Set<number>();
    for (const tr of tracks) {
      if (out.length >= 4) break;
      if (tr.album_id == null || seen.has(tr.album_id)) continue;
      if ((scoreByTrackId.get(tr.id) ?? 0) <= 0) continue;
      const album = albumById.get(tr.album_id);
      if (!trackGenres(tr, album).some((g) => normalizeGenreKey(g) === key)) continue;
      seen.add(tr.album_id);
      const url = album ? coverUrlFor(album, 128) : null;
      if (url) out.push(url);
    }
    return out;
  }

  function openGenre(label: string) {
    session.libraryBrowse = "genres";
    session.selectedGenre = label;
    session.libraryLevel = "artists";
    session.navigate("library");
  }

  async function openAlbumRow(al: Album) {
    if (al.id < 0) return;
    await session.openAlbum(al);
  }

  async function load() {
    ready = false;
    loadError = false;
    try {
      await Promise.all([
        session.ensureCatalogTracks(),
        session.artists.length ? Promise.resolve() : session.loadArtists(),
        session.allAlbums.length ? Promise.resolve() : session.loadAllAlbums(),
        session.favorites.length ? Promise.resolve() : session.loadFavorites(),
      ]);
    } catch {
      // Hub unreachable / failed request: say so instead of empty rankings.
      loadError = true;
    } finally {
      ready = true;
    }
  }

  onMount(() => {
    void load();
    void plectrRecords.ensureReady();
  });

  /** The page title says what the active tab measures. */
  const pageTitle = $derived.by(() => {
    if (metricMode === "favorites") return tp("stats.headerFavorites", totalFavorites);
    if (metricMode === "blocked") return tp("stats.headerBlocked", totalShuffleBlocks);
    if (metricMode === "plectr") return tp("stats.headerPlectr", totalPlectrTracks);
    return tp("stats.headerPlays", overview.totalScore);
  });

  function trackCover(tr: Track): string | null {
    return coverUrlFor(tr, 128);
  }

  function artistCover(id: number | null): string | null {
    if (id == null) return null;
    const albumId = artistCoverById.get(id);
    const album = albumId != null ? albumById.get(albumId) : null;
    return album ? coverUrlFor(album, 128) : null;
  }
</script>

{#snippet rankState(empty: boolean, message: string)}
  {#if !ready}
    <Skeleton variant="row" count={3} label={t("stats.loading")} />
  {:else if loadError}
    <p class="panel-empty statistics-section__empty">{t("stats.loadError")}</p>
  {:else if empty}
    <p class="panel-empty statistics-section__empty">{message}</p>
  {/if}
{/snippet}

{#snippet rankRow(pos: number, label: string, onclick: (() => void) | null, cover: import("svelte").Snippet, title: string, meta: string, value: string)}
  <li>
    <svelte:element
      this={onclick ? "button" : "div"}
      type={onclick ? "button" : undefined}
      class="statistics-rank-row"
      class:statistics-rank-row--static={!onclick}
      aria-label={onclick ? t("stats.openInLibraryAria", { label }) : undefined}
      onclick={onclick ?? undefined}
      role={onclick ? undefined : "group"}
    >
      <span class="statistics-rank-row__pos">{pos}</span>
      {@render cover()}
      <div class="statistics-rank-row__text">
        <div class="statistics-rank-row__title">{title}</div>
        {#if meta}<div class="statistics-rank-row__meta">{meta}</div>{/if}
      </div>
      <div class="statistics-rank-row__plays">{value}</div>
    </svelte:element>
  </li>
{/snippet}

<div class="view-page statistics-page">
  <PageToolbar
    eyebrow={t("page.statistics.eyebrow")}
    title={ready ? pageTitle : t("stats.loading")}
    tabs={METRIC_TABS}
    activeTab={metricMode}
    tabsAriaLabel={t("page.statistics.tabsAria")}
    ontab={(id) => (metricMode = id as MetricMode)}
  >
    {#snippet icon()}
      <UiIcon name="chart" class="section-head__ic" />
    {/snippet}
    {#snippet tools()}
      {#if metricMode === "plectr"}
        <Button variant="ghost" onclick={() => openPlectr("records")}>
          <UiIcon name="plectrum" />
          {t("stats.plectrAllRecords")}
        </Button>
      {/if}
    {/snippet}
  </PageToolbar>

  {#if loadError}
    <div class="statistics-page__error rk-surface-card" role="alert">
      <p>{t("stats.loadErrorLong")}</p>
      <button type="button" class="rk-btn rk-btn--secondary rk-btn--sm" onclick={() => void load()}>
        <UiIcon name="sync" />
        {t("stats.retry")}
      </button>
    </div>
  {/if}

  <div class="statistics-page__sections">
    <div class="statistics-page__rankings" class:statistics-page__rankings--duo={metricMode === "blocked"}>
      {#if metricMode !== "blocked"}
        <Panel title={t("stats.sectionTracks")} class="statistics-section">
          {#snippet actions()}<span class="statistics-section__mode">{modeLabel}</span>{/snippet}
          {@render rankState(rankings.topTracks.length === 0, emptyMessage)}
          {#if ready && !loadError && rankings.topTracks.length > 0}
            <ol class="statistics-rank-list">
              {#each rankings.topTracks as row, i (row.tr.id)}
                {#snippet cover()}
                  <CoverArt kind="track" size="md" class="statistics-rank-row__art" title={row.tr.title} src={trackCover(row.tr)} />
                {/snippet}
                {@render rankRow(i + 1, row.tr.title, () => void openTrack(row.tr), cover, row.tr.title, `${row.tr.artist_name} · ${row.tr.album_name}`, formatMetricValue(row.n, row.tr.rel_path))}
              {/each}
            </ol>
          {/if}
        </Panel>
      {/if}

      <Panel title={t("stats.sectionArtists")} class="statistics-section">
        {#snippet actions()}<span class="statistics-section__mode">{modeLabel}</span>{/snippet}
        {@render rankState(rankings.topArtists.length === 0, emptyMessage)}
        {#if ready && !loadError && rankings.topArtists.length > 0}
          <ol class="statistics-rank-list">
            {#each rankings.topArtists as row, i (`${row.id ?? row.name}`)}
              {#snippet cover()}
                <CoverArt kind="artist" size="md" class="statistics-rank-row__art" title={row.name} src={artistCover(row.id)} />
              {/snippet}
              {@render rankRow(i + 1, row.name, row.id != null ? () => void openArtistRow(row) : null, cover, row.name, "", formatMetricValue(row.n))}
            {/each}
          </ol>
        {/if}
      </Panel>

      <Panel title={t("stats.sectionAlbums")} class="statistics-section">
        {#snippet actions()}<span class="statistics-section__mode">{modeLabel}</span>{/snippet}
        {@render rankState(rankings.topAlbums.length === 0, emptyMessage)}
        {#if ready && !loadError && rankings.topAlbums.length > 0}
          <ol class="statistics-rank-list">
            {#each rankings.topAlbums as row, i (row.al.id < 0 ? row.al.folder_key : row.al.id)}
              {#snippet cover()}
                <CoverArt kind="album" size="md" class="statistics-rank-row__art" title={row.al.name} src={row.al.id >= 0 ? coverUrlFor(row.al, 128) : null} />
              {/snippet}
              {@render rankRow(i + 1, row.al.name, row.al.id >= 0 ? () => void openAlbumRow(row.al) : null, cover, row.al.name, row.al.artist_name, formatMetricValue(row.n))}
            {/each}
          </ol>
        {/if}
      </Panel>
    </div>

    <div class="statistics-page__footer">
      <Panel title={t("stats.sectionGenres")} class="statistics-section statistics-section--genres">
        {#snippet actions()}<span class="statistics-section__mode">{modeLabel}</span>{/snippet}
        {@render rankState(rankings.topGenres.length === 0, t("stats.genresEmpty"))}
        {#if ready && !loadError && rankings.topGenres.length > 0}
          <ol class="statistics-rank-list">
            {#each rankings.topGenres as row, i (row.key)}
              {#snippet cover()}
                <CoverArt kind="genre" size="md" class="statistics-rank-row__art" title={row.label} srcs={genreCovers(row.key)} />
              {/snippet}
              {@render rankRow(i + 1, row.label, () => openGenre(row.label), cover, row.label, "", formatMetricValue(row.n))}
            {/each}
          </ol>
        {/if}
      </Panel>

      <Panel title={t("stats.sectionOverview")} class="statistics-section statistics-section--overview">
        {#snippet actions()}<span class="statistics-section__mode">{t("stats.modeAll")}</span>{/snippet}
        <div class="statistics-kpis" aria-label={t("stats.overviewPlaysRowAria")}>
          <Metric label={t("stats.overviewTotalPlays")} value={fmtN(overview.totalScore)} loading={!ready} />
          <Metric label={t("stats.overviewTracksWithPlays")} value={fmtN(overview.tracksWithPlays)} loading={!ready} />
          <Metric label={t("stats.overviewArtistsTouched")} value={fmtN(overview.artistsTouched)} loading={!ready} />
          <Metric label={t("stats.overviewAlbumsTouched")} value={fmtN(overview.albumsTouched)} loading={!ready} />
        </div>
        <div class="statistics-kpis statistics-kpis--totals" aria-label={t("stats.overviewTotalsRowAria")}>
          <Metric label={t("stats.overviewFavoritesTotal")} value={fmtN(totalFavorites)} loading={!ready} />
          <Metric label={t("stats.kpiShuffleBlocked")} value={fmtN(totalShuffleBlocks)} loading={!ready} />
          <Metric label={t("stats.overviewPlectrTracks")} value={fmtN(totalPlectrTracks)} />
        </div>
      </Panel>
    </div>
  </div>
</div>

<style>
  .statistics-page__error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--rk-space-lg);
    flex-wrap: wrap;
    padding: var(--rk-space-lg) var(--rk-space-xl);
    border-color: color-mix(in srgb, var(--rk-danger) 40%, var(--rk-line));
    background: color-mix(in srgb, var(--rk-danger-soft) 60%, var(--rk-surface));
  }

  .statistics-page__error p {
    margin: 0;
    font-size: var(--rk-fs-sm);
    color: var(--rk-ink);
  }
  .statistics-kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(7.5rem, 100%), 1fr));
    gap: 0.55rem;
  }

  .statistics-kpis--totals {
    margin-top: 0.55rem;
  }

  :global(.rk-cover.statistics-rank-row__art) {
    flex-shrink: 0;
  }
</style>
