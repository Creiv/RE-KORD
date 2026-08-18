<script lang="ts">
  import { onMount } from "svelte";
  import { Panel } from "@rekord/ui";
  import PageToolbar from "../components/PageToolbar.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import {
    albumCoverUrl,
    api,
    type Album,
    type Artist,
    type Track,
  } from "../lib/api";
  import { buildArtistCoverAlbumMap } from "../lib/artistCover";
  import { initials } from "../lib/initials";
  import { player } from "../lib/player";
  import { i18n, t } from "../lib/i18n.svelte";
  import { session } from "../lib/session.svelte";
  import { trackGenre } from "../lib/trackMoods";

  type MetricMode = "plays" | "favorites" | "blocked";

  const TOP_N = 3;
  const METRIC_TABS = $derived([
    { id: "plays", label: t("page.statistics.tab.plays") },
    { id: "favorites", label: t("page.statistics.tab.favorites") },
    { id: "blocked", label: t("page.statistics.tab.blocked") },
  ]);

  let metricMode = $state<MetricMode>("plays");
  let ready = $state(false);

  const fmtN = (n: number) =>
    n.toLocaleString(i18n.locale === "en" ? "en-US" : "it-IT");

  const modeLabel = $derived(
    METRIC_TABS.find((tab) => tab.id === metricMode)?.label ?? "",
  );

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
    session.tick;
    session.favorites;
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
          a.tr.title.localeCompare(b.tr.title, "it", { numeric: true }) ||
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
        b.n - a.n || a.name.localeCompare(b.name, "it", { numeric: true }),
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
            a.al.name.localeCompare(b.al.name, "it", { numeric: true }),
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
          a.al.name.localeCompare(b.al.name, "it", { numeric: true }),
      );
    }

    const genreMap = new Map<string, RankGenre>();
    for (const tr of tracks) {
      const n = score.get(tr.id) ?? 0;
      if (n <= 0) continue;
      const label = trackGenre(tr);
      if (!label || label === "Senza genere") continue;
      const key = label.toLowerCase();
      const prev = genreMap.get(key);
      if (prev) prev.n += n;
      else genreMap.set(key, { key, label, n });
    }
    const topGenres = [...genreMap.values()]
      .sort(
        (a, b) =>
          b.n - a.n || a.label.localeCompare(b.label, "it", { numeric: true }),
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
    session.tick;
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
    session.tick;
    return tracks.filter((tr) => player.isTrackExcluded(tr)).length;
  });

  function formatMetricValue(n: number): string {
    if (metricMode === "plays") return `Ascolti: ${fmtN(n)}`;
    if (metricMode === "favorites") return `${fmtN(n)} preferiti`;
    if (false as boolean) return fmtN(n);
    return `${fmtN(n)} bloccati`;
  }

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

  async function openAlbumRow(al: Album) {
    if (al.id < 0) return;
    await session.openAlbum(al);
  }

  onMount(() => {
    void (async () => {
      try {
        await Promise.all([
          session.ensureCatalogTracks(),
          session.artists.length ? Promise.resolve() : session.loadArtists(),
          session.allAlbums.length ? Promise.resolve() : session.loadAllAlbums(),
          session.favorites.length ? Promise.resolve() : session.loadFavorites(),
        ]);
      } finally {
        ready = true;
      }
    })();
    return player.subscribe(() => {
      session.tick += 1;
    });
  });
</script>

<div class="view-page statistics-page">
  <PageToolbar
    eyebrow={t("page.statistics.eyebrow")}
    title={t("page.statistics.title", { plays: fmtN(overview.totalScore) })}
    tabs={METRIC_TABS}
    activeTab={metricMode}
    tabsAriaLabel={t("page.statistics.tabsAria")}
    ontab={(id) => (metricMode = id as MetricMode)}
  >
    {#snippet icon()}
      <UiIcon name="chart" class="section-head__ic" />
    {/snippet}
  </PageToolbar>

  <div class="statistics-page__sections">
    <div
      class="statistics-page__rankings"
      class:statistics-page__rankings--duo={metricMode === "blocked"}
    >
      {#if metricMode !== "blocked"}
        <Panel title="Top 3 brani" class="statistics-section">
          {#snippet actions()}
            <span class="statistics-section__mode">{modeLabel}</span>
          {/snippet}
          {#if !ready}
            <p class="panel-empty statistics-section__empty">Caricamento…</p>
          {:else if rankings.topTracks.length === 0}
            <p class="panel-empty statistics-section__empty">
              Ancora niente qui — continua ad ascoltare.
            </p>
          {:else}
            <ol class="statistics-rank-list">
              {#each rankings.topTracks as row, i (row.tr.id)}
                <li>
                  <button
                    type="button"
                    class="statistics-rank-row"
                    aria-label="Apri in libreria: {row.tr.title}"
                    onclick={() => void openTrack(row.tr)}
                  >
                    <span class="statistics-rank-row__pos">{i + 1}</span>
                    {#if row.tr.album_id != null}
                      <img
                        class="statistics-rank-row__art"
                        src={albumCoverUrl(row.tr.album_id, 128)}
                        alt=""
                        loading="lazy"
                      />
                    {:else}
                      <div
                        class="statistics-rank-row__art statistics-rank-row__art--fallback"
                        aria-hidden="true"
                      >
                        <UiIcon name="music" />
                      </div>
                    {/if}
                    <div class="statistics-rank-row__text">
                      <div class="statistics-rank-row__title">{row.tr.title}</div>
                      <div class="statistics-rank-row__meta">
                        {row.tr.artist_name} — {row.tr.album_name}
                      </div>
                    </div>
                    <div class="statistics-rank-row__plays">
                      {formatMetricValue(row.n)}
                    </div>
                  </button>
                </li>
              {/each}
            </ol>
          {/if}
        </Panel>
      {/if}

      <Panel title="Top 3 artisti" class="statistics-section">
        {#snippet actions()}
          <span class="statistics-section__mode">{modeLabel}</span>
        {/snippet}
        {#if !ready}
          <p class="panel-empty statistics-section__empty">Caricamento…</p>
        {:else if rankings.topArtists.length === 0}
          <p class="panel-empty statistics-section__empty">
            Ancora niente qui — continua ad ascoltare.
          </p>
        {:else}
          <ol class="statistics-rank-list">
            {#each rankings.topArtists as row, i (`${row.id ?? row.name}`)}
              {@const coverId = row.id != null ? artistCoverById.get(row.id) : undefined}
              <li>
                <button
                  type="button"
                  class="statistics-rank-row"
                  aria-label="Apri in libreria: {row.name}"
                  onclick={() => void openArtistRow(row)}
                >
                  <span class="statistics-rank-row__pos">{i + 1}</span>
                  {#if coverId != null}
                    <img
                      class="statistics-rank-row__art"
                      src={albumCoverUrl(coverId, 128)}
                      alt=""
                      loading="lazy"
                    />
                  {:else}
                    <div
                      class="statistics-rank-row__art statistics-rank-row__art--fallback"
                      aria-hidden="true"
                    >
                      {initials(row.name)}
                    </div>
                  {/if}
                  <div class="statistics-rank-row__text">
                    <div class="statistics-rank-row__title">{row.name}</div>
                  </div>
                  <div class="statistics-rank-row__plays">
                    {formatMetricValue(row.n)}
                  </div>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </Panel>

      <Panel title="Top 3 album" class="statistics-section">
        {#snippet actions()}
          <span class="statistics-section__mode">{modeLabel}</span>
        {/snippet}
        {#if !ready}
          <p class="panel-empty statistics-section__empty">Caricamento…</p>
        {:else if rankings.topAlbums.length === 0}
          <p class="panel-empty statistics-section__empty">
            Ancora niente qui — continua ad ascoltare.
          </p>
        {:else}
          <ol class="statistics-rank-list">
            {#each rankings.topAlbums as row, i (row.al.id < 0 ? row.al.folder_key : row.al.id)}
              <li>
                <button
                  type="button"
                  class="statistics-rank-row"
                  aria-label="Apri in libreria: {row.al.name}"
                  onclick={() => void openAlbumRow(row.al)}
                >
                  <span class="statistics-rank-row__pos">{i + 1}</span>
                  {#if row.al.id >= 0 && row.al.has_cover}
                    <img
                      class="statistics-rank-row__art"
                      src={albumCoverUrl(row.al.id, 128)}
                      alt=""
                      loading="lazy"
                    />
                  {:else}
                    <div
                      class="statistics-rank-row__art statistics-rank-row__art--fallback"
                      aria-hidden="true"
                    >
                      <UiIcon name="music" />
                    </div>
                  {/if}
                  <div class="statistics-rank-row__text">
                    <div class="statistics-rank-row__title">{row.al.name}</div>
                    <div class="statistics-rank-row__meta">{row.al.artist_name}</div>
                  </div>
                  <div class="statistics-rank-row__plays">
                    {formatMetricValue(row.n)}
                  </div>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </Panel>
    </div>

    <div class="statistics-page__footer">
      <Panel title="Top 3 generi" class="statistics-section statistics-section--genres">
        {#snippet actions()}
          <span class="statistics-section__mode">{modeLabel}</span>
        {/snippet}
        {#if !ready}
          <p class="panel-empty statistics-section__empty">Caricamento…</p>
        {:else if rankings.topGenres.length === 0}
            <p class="panel-empty statistics-section__empty">
              Nessun ascolto su brani con genere, oppure ancora nessun dato.
            </p>
        {:else}
          <ol class="statistics-rank-list">
            {#each rankings.topGenres as row, i (row.key)}
              <li>
                <div
                  class="statistics-rank-row statistics-rank-row--static statistics-rank-row--genre-simple"
                >
                  <span class="statistics-rank-row__pos">{i + 1}</span>
                  <div class="statistics-rank-row__text">
                    <div class="statistics-rank-row__title">{row.label}</div>
                  </div>
                  <div class="statistics-rank-row__plays">
                    {formatMetricValue(row.n)}
                  </div>
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </Panel>

      <Panel title="In sintesi" class="statistics-section statistics-section--overview">
        {#snippet actions()}
          <span class="statistics-section__mode">Tutto</span>
        {/snippet}
        <div class="statistics-overview">
          <div
            class="stats-grid statistics-overview-grid statistics-overview-grid--plays"
            aria-label="Riepilogo riproduzioni"
          >
            <div class="metric-card">
              <span>Riproduzioni totali</span>
              <strong>{fmtN(overview.totalScore)}</strong>
            </div>
            <div class="metric-card">
              <span>Brani riprodotti</span>
              <strong>{fmtN(overview.tracksWithPlays)}</strong>
            </div>
            <div class="metric-card">
              <span>Artisti coinvolti</span>
              <strong>{fmtN(overview.artistsTouched)}</strong>
            </div>
            <div class="metric-card">
              <span>Album coinvolti</span>
              <strong>{fmtN(overview.albumsTouched)}</strong>
            </div>
          </div>
          <div
            class="stats-grid statistics-overview-grid statistics-overview-grid--totals"
            aria-label="Totali preferiti ed esclusioni"
          >
            <div class="metric-card">
              <span>Totale preferiti</span>
              <strong>{fmtN(totalFavorites)}</strong>
            </div>
            <div class="metric-card">
              <span>Totale esclusi (random)</span>
              <strong>{fmtN(totalShuffleBlocks)}</strong>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  </div>
</div>
