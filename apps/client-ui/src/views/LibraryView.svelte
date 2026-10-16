<script lang="ts">
  /**
   * Library: artists / genres / moods / Nebula overview, artist page. The
   * album page and the search results live in `components/views/library/`.
   */
  import { onMount } from "svelte";
  import { Button, EmptyState, Skeleton } from "@rekord/ui";
  import EntityInfoAction from "../components/EntityInfoAction.svelte";
  import GenreListTile from "../components/GenreListTile.svelte";
  import MediaGrid from "../components/MediaGrid.svelte";
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import SonicNebula from "../components/nebula/SonicNebula.svelte";
  import MoodFilterGrid from "../components/views/MoodFilterGrid.svelte";
  import LibraryAlbumDetail from "../components/views/library/LibraryAlbumDetail.svelte";
  import LibrarySearch from "../components/views/library/LibrarySearch.svelte";
  import SortSegmented from "../components/views/library/SortSegmented.svelte";
  import { api, coverUrlFor, type Album, type Track } from "../lib/api";
  import { buildArtistCoverAlbumMap } from "../lib/artistCover";
  import { normalizeGenreKey, trackGenres } from "../lib/genres";
  import { t, tp } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { prefsRevision } from "../lib/prefsRevision.svelte";
  import { session, type LibraryBrowse } from "../lib/session.svelte";
  import { describeError, toasts } from "../lib/toasts.svelte";
  import {
    NO_GENRE_KEY,
    TRACK_MOOD_IDS,
    albumHasAlbumMeta,
    resolveTrackMoods,
    trackHasFileMeta,
    trackMatchesMoodFilter,
    trackYear,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";

  /** Synced per account (legacy `libOverviewSort` / `artistAlbumSort`). */
  const overviewSort = $derived(session.libOverviewSort);
  const artistAlbumSort = $derived(session.artistAlbumSort);
  /** Catalog load failure (genres / moods / nebula need the full track list). */
  let catalogError = $state<string | null>(null);
  let catalogLoading = $state(false);

  async function loadCatalog() {
    catalogLoading = true;
    catalogError = null;
    try {
      await session.ensureCatalogTracks();
    } catch (e) {
      catalogError = describeError(e);
    } finally {
      catalogLoading = false;
    }
  }

  onMount(() => {
    void loadCatalog();
  });

  const artistCoverById = $derived(buildArtistCoverAlbumMap(session.artists, session.allAlbums));
  const albumById = $derived(new Map<number, Album>(session.allAlbums.map((a) => [a.id, a])));
  const discOf = (tr: Track) => (tr as Track & { disc_number?: number | null }).disc_number ?? 0;

  const browseTabs = $derived([
    { id: "artists", label: t("page.library.tab.artists") },
    { id: "genres", label: t("page.library.tab.genres") },
    { id: "moods", label: t("page.library.tab.moods") },
    { id: "nebula", label: t("nebula.tab") },
  ]);

  /** Play counts snapshot: one prefs read, refreshed only when counts change. */
  const playCounts = $derived.by(() => {
    void prefsRevision.playCounts;
    return loadUserPrefs().playCounts;
  });

  function playsOf(tr: Track): number {
    return playCounts[tr.rel_path] ?? playCounts[String(tr.id)] ?? 0;
  }

  /** Exclusion sets snapshot (player keeps them in memory; prefs patch bumps the revision). */
  const exclusions = $derived.by(() => {
    void prefsRevision.exclusions;
    return {
      paths: new Set(player.getExcludedRelPaths()),
      albums: new Set(player.getExcludedAlbumIds()),
    };
  });

  // ── Genres ───────────────────────────────────────────────────────────────
  // Split ("Hip Hop; Pop Rap" counts for both) and normalized ("hip-hop" =
  // "Hip Hop") through lib/genres; the hub's `genres` list wins when present.

  /** Genre keys of each catalog track (album genres as fallback), with labels. */
  const genreIndex = $derived.by(() => {
    const keysByTrack = new Map<number, string[]>();
    const labels = new Map<string, string>();
    for (const tr of session.catalogTracks) {
      const album = tr.album_id != null ? albumById.get(tr.album_id) : null;
      const keys: string[] = [];
      for (const label of trackGenres(tr, album)) {
        const key = normalizeGenreKey(label);
        if (!key) continue;
        keys.push(key);
        if (!labels.has(key)) labels.set(key, label);
      }
      keysByTrack.set(tr.id, keys.length ? keys : [NO_GENRE_KEY]);
    }
    return { keysByTrack, labels };
  });

  function genreKeyOf(nameOrKey: string): string {
    return nameOrKey === NO_GENRE_KEY ? NO_GENRE_KEY : normalizeGenreKey(nameOrKey);
  }

  function genreLabel(nameOrKey: string): string {
    if (nameOrKey === NO_GENRE_KEY) return t("library.noGenre");
    return genreIndex.labels.get(normalizeGenreKey(nameOrKey)) ?? nameOrKey;
  }

  const genreBuckets = $derived.by(() => {
    const byKey = new Map<string, { albumIds: Set<number>; tracks: number; plays: number }>();
    if (session.catalogTracks.length) {
      for (const tr of session.catalogTracks) {
        const plays = playsOf(tr);
        for (const key of genreIndex.keysByTrack.get(tr.id) ?? [NO_GENRE_KEY]) {
          let cur = byKey.get(key);
          if (!cur) {
            cur = { albumIds: new Set(), tracks: 0, plays: 0 };
            byKey.set(key, cur);
          }
          cur.tracks += 1;
          cur.plays += plays;
          if (tr.album_id != null) cur.albumIds.add(tr.album_id);
        }
      }
    } else {
      for (const a of session.allAlbums) {
        const labels = trackGenres(a);
        for (const key of labels.length ? labels.map(normalizeGenreKey) : [NO_GENRE_KEY]) {
          let cur = byKey.get(key);
          if (!cur) {
            cur = { albumIds: new Set(), tracks: 0, plays: 0 };
            byKey.set(key, cur);
          }
          cur.tracks += a.track_count;
          cur.albumIds.add(a.id);
        }
      }
    }
    return [...byKey.entries()].map(([key, v]) => {
      const albums = [...v.albumIds].map((id) => albumById.get(id)).filter((a): a is Album => Boolean(a));
      return {
        key,
        label: key === NO_GENRE_KEY ? t("library.noGenre") : (genreIndex.labels.get(key) ?? key),
        albumCount: albums.length,
        trackCount: v.tracks,
        plays: v.plays,
        // Only albums with artwork: the mosaic adapts to 1-4 covers, never empty cells.
        covers: albums
          .map((a) => coverUrlFor(a, 128))
          .filter((u): u is string => Boolean(u))
          .slice(0, 4),
      };
    });
  });

  const sortedGenreBuckets = $derived.by(() => {
    const list = [...genreBuckets];
    // Match React: the "no genre" bucket is always pinned first.
    list.sort((a, b) => {
      if (a.key === NO_GENRE_KEY) return -1;
      if (b.key === NO_GENRE_KEY) return 1;
      if (overviewSort === "plays") return b.plays - a.plays || a.label.localeCompare(b.label);
      return a.label.localeCompare(b.label);
    });
    return list;
  });

  const selectedGenreKey = $derived(session.selectedGenre ? genreKeyOf(session.selectedGenre) : null);
  const selectedGenreBucket = $derived(
    selectedGenreKey ? (sortedGenreBuckets.find((g) => g.key === selectedGenreKey) ?? null) : null,
  );

  function compareArtistAlbumTitle(a: Track, b: Track) {
    return (
      a.artist_name.localeCompare(b.artist_name, undefined, { numeric: true }) ||
      a.album_name.localeCompare(b.album_name, undefined, { numeric: true }) ||
      discOf(a) - discOf(b) ||
      (a.track_number ?? 0) - (b.track_number ?? 0) ||
      a.title.localeCompare(b.title, undefined, { numeric: true })
    );
  }

  /** Like React `sortedGenreTracks`: the genre's tracks, sorted by name or plays. */
  const sortedGenreTracks = $derived.by(() => {
    const key = selectedGenreKey;
    if (!key) return [];
    const base = session.catalogTracks.filter((tr) =>
      (genreIndex.keysByTrack.get(tr.id) ?? [NO_GENRE_KEY]).includes(key),
    );
    if (overviewSort === "plays") {
      base.sort((a, b) => playsOf(b) - playsOf(a) || compareArtistAlbumTitle(a, b));
    } else {
      base.sort(compareArtistAlbumTitle);
    }
    return base;
  });

  // ── Navigation ───────────────────────────────────────────────────────────

  async function selectArtist(id: number | string) {
    try {
      const artist = await api.artist(Number(id));
      await session.openArtist(artist);
    } catch (e) {
      toasts.fail(e);
    }
  }

  async function selectAlbum(id: number | string) {
    try {
      const album = await api.album(Number(id));
      await session.openAlbum(album);
    } catch (e) {
      toasts.fail(e);
    }
  }

  function setBrowse(id: string) {
    session.libraryBrowse = id as LibraryBrowse;
    session.selectedGenre = null;
    session.moodFilterIds = [];
    if (id !== "artists" && !session.catalogTracks.length && !catalogLoading) {
      void loadCatalog();
    }
  }

  // ── Moods ────────────────────────────────────────────────────────────────

  function toggleMood(id: string) {
    session.moodFilterIds = session.moodFilterIds.includes(id)
      ? session.moodFilterIds.filter((x) => x !== id)
      : [...session.moodFilterIds, id];
  }

  const savedMoods = $derived.by(() => {
    void session.moodPrefsTick;
    void prefsRevision.moods;
    return loadUserPrefs().trackMoods;
  });

  const moodCounts = $derived.by(() => {
    const counts = Object.fromEntries(TRACK_MOOD_IDS.map((id) => [id, 0])) as Record<TrackMoodId, number>;
    for (const tr of session.catalogTracks) {
      for (const m of resolveTrackMoods(tr.id, tr.rel_path, savedMoods)) counts[m] += 1;
    }
    return counts;
  });

  const moodFilteredTracks = $derived.by(() => {
    if (!session.moodFilterIds.length) return [];
    return session.catalogTracks
      .filter((tr) =>
        trackMatchesMoodFilter(
          resolveTrackMoods(tr.id, tr.rel_path, savedMoods),
          session.moodFilterIds,
          session.moodMatchAll,
        ),
      )
      .sort(compareArtistAlbumTitle);
  });

  // ── Overview / artist page ───────────────────────────────────────────────

  const browseIcon = $derived(
    session.libraryBrowse === "artists"
      ? "person"
      : session.libraryBrowse === "genres"
        ? "style"
        : session.libraryBrowse === "nebula"
          ? "sparkle"
          : "palette",
  );

  /** The page title says what the active tab is showing, not the tab name. */
  const browseSummary = $derived.by(() => {
    if (session.libraryBrowse === "genres") {
      return tp("page.library.summaryGenres", sortedGenreBuckets.length);
    }
    if (session.libraryBrowse === "moods") return t("page.library.summaryMoods");
    if (session.libraryBrowse === "nebula") {
      return t("nebula.summary", { tracks: tp("library.tracksCount", session.catalogTracks.length) });
    }
    return `${tp("library.artistsCount", session.artists.length)} · ${tp("library.albumsCount", session.allAlbums.length)}`;
  });

  /**
   * Per-artist / per-album aggregates in one pass over the catalog (was a
   * filter of the whole catalog per artist, re-run on every player tick).
   */
  const catalogAgg = $derived.by(() => {
    const ex = exclusions;
    const favByArtist = new Map<number, number>();
    const favByAlbum = new Map<number, number>();
    for (const f of session.favorites) {
      if (f.artist_id != null) favByArtist.set(f.artist_id, (favByArtist.get(f.artist_id) ?? 0) + 1);
      if (f.album_id != null) favByAlbum.set(f.album_id, (favByAlbum.get(f.album_id) ?? 0) + 1);
    }
    type Agg = { plays: number; missingMeta: number; excluded: number; excludedPaths: number };
    const byArtist = new Map<number, Agg>();
    const byAlbum = new Map<number, Agg>();
    const bump = (map: Map<number, Agg>, id: number) => {
      let cur = map.get(id);
      if (!cur) {
        cur = { plays: 0, missingMeta: 0, excluded: 0, excludedPaths: 0 };
        map.set(id, cur);
      }
      return cur;
    };
    for (const tr of session.catalogTracks) {
      const plays = playsOf(tr);
      const missing = trackHasFileMeta(tr) ? 0 : 1;
      const pathEx = ex.paths.has(tr.rel_path) ? 1 : 0;
      const albumEx = tr.album_id != null && ex.albums.has(tr.album_id) ? 1 : 0;
      if (tr.artist_id != null) {
        const a = bump(byArtist, tr.artist_id);
        a.plays += plays;
        a.missingMeta += missing;
        a.excluded += albumEx || pathEx;
      }
      if (tr.album_id != null) {
        const al = bump(byAlbum, tr.album_id);
        al.plays += plays;
        al.missingMeta += missing;
        al.excludedPaths += pathEx;
      }
    }
    const albumsByArtist = new Map<number, Album[]>();
    for (const al of session.allAlbums) {
      if (al.artist_id == null) continue;
      const list = albumsByArtist.get(al.artist_id);
      if (list) list.push(al);
      else albumsByArtist.set(al.artist_id, [al]);
    }
    return { favByArtist, favByAlbum, byArtist, byAlbum, albumsByArtist };
  });

  const sortedArtists = $derived.by(() => {
    const list = [...session.artists];
    if (overviewSort === "plays") {
      const plays = (id: number) => catalogAgg.byArtist.get(id)?.plays ?? 0;
      list.sort((a, b) => plays(b.id) - plays(a.id) || a.name.localeCompare(b.name));
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  });

  const artistItems = $derived(
    sortedArtists.map((a) => {
      const coverAlbumId = artistCoverById.get(a.id);
      const coverAlbum = coverAlbumId != null ? albumById.get(coverAlbumId) : null;
      const albums = catalogAgg.albumsByArtist.get(a.id) ?? [];
      const agg = catalogAgg.byArtist.get(a.id);
      return {
        id: a.id,
        title: a.name,
        subtitle: t("library.artistSubtitle", {
          albums: tp("library.albumsCount", a.album_count),
          tracks: tp("library.tracksCount", a.track_count),
        }),
        coverSrc: coverAlbum ? coverUrlFor(coverAlbum, 256) : null,
        coverSeed: a.name,
        favoriteCount: catalogAgg.favByArtist.get(a.id) ?? 0,
        albumsMissingMetaCount: albums.filter((al) => !al.loose && !albumHasAlbumMeta(al)).length,
        tracksMissingMetaCount: agg?.missingMeta ?? 0,
        albumsExcludedCount: albums.filter((al) => exclusions.albums.has(al.id)).length,
        tracksExcludedCount: agg?.excluded ?? 0,
      };
    }),
  );

  /** Artist folder on disk (curiosità are keyed by folder, not display name). */
  const selectedArtistDir = $derived.by(() => {
    const artist = session.selectedArtist;
    if (!artist) return "";
    const album = (catalogAgg.albumsByArtist.get(artist.id) ?? session.albums)[0];
    return album?.folder_key.split("/")[0]?.trim() || artist.name;
  });

  const sortedArtistAlbums = $derived.by(() => {
    const list = [...session.albums];
    if (artistAlbumSort === "date") {
      list.sort((a, b) => {
        const da = a.release_date?.trim() || trackYear(null, a) || "";
        const db = b.release_date?.trim() || trackYear(null, b) || "";
        if (!da && !db) return a.name.localeCompare(b.name, undefined, { numeric: true });
        if (!da) return 1;
        if (!db) return -1;
        return (
          db.localeCompare(da, undefined, { numeric: true }) ||
          a.name.localeCompare(b.name, undefined, { numeric: true })
        );
      });
    } else if (artistAlbumSort === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    } else {
      const albumPlays = (albumId: number) => catalogAgg.byAlbum.get(albumId)?.plays ?? 0;
      list.sort(
        (a, b) =>
          albumPlays(b.id) - albumPlays(a.id) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    }
    return list;
  });

  const artistAlbumItems = $derived(
    sortedArtistAlbums.map((a) => {
      const agg = catalogAgg.byAlbum.get(a.id);
      const albumEx = exclusions.albums.has(a.id);
      const year = trackYear(null, a);
      const tracksLabel = tp("library.tracksCount", a.track_count);
      return {
        id: a.id,
        kind: "album" as const,
        title: a.name,
        /* Like React's artist AlbumListTile: no artist row (already in context) */
        metaLine: year ? `${tracksLabel} · ${year}` : tracksLabel,
        coverSrc: coverUrlFor(a, 256),
        coverSeed: `${session.selectedArtist?.name}/${a.name}`,
        favoriteCount: catalogAgg.favByAlbum.get(a.id) ?? 0,
        tracksMissingMetaCount: agg?.missingMeta ?? 0,
        genreMissing: !albumHasAlbumMeta(a),
        albumExcluded: albumEx,
        tracksExcludedCount: albumEx ? a.track_count : (agg?.excludedPaths ?? 0),
        loose: a.loose,
      };
    }),
  );
</script>

<div class="view-page library-page">
{#if session.libraryLevel === "artists"}
  {#if session.libraryBrowse === "genres" && session.selectedGenre}
    <PageToolbar
      eyebrow={t("page.library.genreEyebrow")}
      title={genreLabel(session.selectedGenre)}
      back={{
        label: t("page.library.backToGenres"),
        onclick: () => (session.selectedGenre = null),
      }}
    >
      {#snippet tools()}
        <PlayCollectionButton
          label={t("page.library.playGenre")}
          disabled={!sortedGenreTracks.length}
          onclick={() => session.playPoolShuffle(sortedGenreTracks)}
        />
      {/snippet}
    </PageToolbar>
  {:else}
    <PageToolbar
      eyebrow={t("page.library.eyebrow")}
      title={browseSummary}
      tabs={browseTabs}
      activeTab={session.libraryBrowse}
      tabsAriaLabel={t("page.library.tabsAria")}
      ontab={setBrowse}
    >
      {#snippet icon()}
        <UiIcon name={browseIcon} class="section-head__ic" />
      {/snippet}
      {#snippet tools()}
        <PlayCollectionButton
          label={t("page.library.playAll")}
          onclick={() => void session.shuffleLibrary()}
        />
      {/snippet}
    </PageToolbar>
  {/if}

  <section
    class="rk-surface-card library-page-body"
  >
    {#if catalogError && session.libraryBrowse !== "artists"}
      <div class="library-catalog-error" role="alert">
        <span>{t("library.catalogError", { error: catalogError })}</span>
        <button type="button" class="mood-clear" disabled={catalogLoading} onclick={() => void loadCatalog()}>
          {t("library.retry")}
        </button>
      </div>
    {/if}
    {#if session.libraryBrowse === "genres" && session.selectedGenre}
      <div class="library-filter-panel library-filter-panel--tight library-sort-panel library-genre-tracklist-toolbar">
        <div class="section-head section-head--page-toolbar">
          <div>
            <p class="rk-eyebrow">{t("library.tracklist")}</p>
            <h2>
              {tp("library.albumsCount", selectedGenreBucket?.albumCount ?? 0)} ·
              {tp("library.tracksCount", sortedGenreTracks.length)}
            </h2>
          </div>
          <div class="section-head__tools">
            <SortSegmented ariaLabel={t("library.sortAria")} value={overviewSort} onchange={(v) => (session.libOverviewSort = v as typeof session.libOverviewSort)} />
          </div>
        </div>
      </div>
    {:else if session.libraryBrowse === "artists" || session.libraryBrowse === "genres"}
      <div class="library-filter-panel library-sort-panel library-genre-tracklist-toolbar">
        <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
          <div>
            <h2>
              {#if session.libraryBrowse === "artists"}
                {tp("library.artistsFound", sortedArtists.length)}
              {:else}
                {tp("library.genresFound", sortedGenreBuckets.length)}
              {/if}
            </h2>
          </div>
          <div class="section-head__tools library-overview-toolbar">
            <SortSegmented ariaLabel={t("library.sortAria")} value={overviewSort} onchange={(v) => (session.libOverviewSort = v as typeof session.libOverviewSort)} />
          </div>
        </div>
      </div>
    {/if}

    {#if session.libraryBrowse === "artists"}
      {#if !artistItems.length && (catalogLoading || !session.catalogLoaded)}
        <Skeleton variant="tile" count={6} label={t("dashboard.loading")} />
      {:else}
        <MediaGrid kind="artist" items={artistItems} onselect={(id) => void selectArtist(id)}>
          {#snippet empty()}
            <EmptyState title={t("library.emptyArtists")} body={t("library.emptyArtistsBody")}>
              {#snippet icon()}<UiIcon name="person" />{/snippet}
              {#snippet action()}
                <Button
                  onclick={() => {
                    session.studioPane = "catalog";
                    session.navigate("studio");
                  }}
                >
                  <UiIcon name="sparkle" />
                  {t("dashboard.emptyChooseLibrary")}
                </Button>
              {/snippet}
            </EmptyState>
          {/snippet}
        </MediaGrid>
      {/if}
    {:else if session.libraryBrowse === "genres"}
      {#if session.selectedGenre}
        <TrackList
          tracks={sortedGenreTracks}
          favoriteIds={session.favoriteIds}
          playlistOptions={session.playlistOptions}
          activeTrackId={session.current?.id ?? null}
          emptyMessage={t("library.emptyGenreTracks")}
          onplay={(track, list) => session.playCollectionShuffle(track, list)}
          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
          onaddToPlaylist={(playlistId, track) =>
            void session.addToPlaylist(playlistId, track.id)}
        />
      {:else}
        <div class="genre-list">
          {#each sortedGenreBuckets as g (g.key)}
            <GenreListTile
              title={g.label}
              albumCount={g.albumCount}
              trackCount={g.trackCount}
              coverSlots={g.covers}
              onclick={() => {
                void session.ensureCatalogTracks();
                session.selectedGenre = g.key === NO_GENRE_KEY ? NO_GENRE_KEY : g.label;
              }}
            />
          {/each}
        </div>
      {/if}
    {:else if session.libraryBrowse === "moods"}
      <div class="library-mood-browse">
        <MoodFilterGrid
          selected={session.moodFilterIds}
          counts={moodCounts}
          matchAll={session.moodMatchAll}
          countsReady={session.catalogTracks.length > 0}
          onmatch={(all) => (session.moodMatchAll = all)}
          ontoggle={(id) => toggleMood(id)}
        >
          {#snippet tools()}
            {#if session.moodFilterIds.length}
              <button type="button" class="mood-clear" onclick={() => (session.moodFilterIds = [])}>
                {t("library.moodClear")}
              </button>
            {/if}
          {/snippet}
        </MoodFilterGrid>
        <p class="mood-hint">{t("library.moodHint")}</p>

        {#if session.moodFilterIds.length}
          <div class="mood-results">
            <div class="mood-results-head">
              <SectionHeadLead
                eyebrow={t("library.results")}
                title={tp("library.tracksCount", moodFilteredTracks.length)}
              >
                <UiIcon name="music" />
              </SectionHeadLead>
              <PlayCollectionButton
                label={t("library.listen")}
                disabled={!moodFilteredTracks.length}
                onclick={() => session.playPoolShuffle(moodFilteredTracks)}
              />
            </div>
            <TrackList
              tracks={moodFilteredTracks}
              favoriteIds={session.favoriteIds}
              playlistOptions={session.playlistOptions}
              activeTrackId={session.current?.id ?? null}
              onplay={(track, list) => session.playCollectionShuffle(track, list)}
              ontoggleFavorite={(track) => void session.toggleFavorite(track)}
              onaddToPlaylist={(playlistId, track) =>
                void session.addToPlaylist(playlistId, track.id)}
            />
          </div>
        {:else}
          <p class="mood-pick-hint">{t("library.moodPickHint")}</p>
        {/if}
      </div>
    {:else if session.libraryBrowse === "nebula"}
      <SonicNebula tracks={session.catalogTracks} loading={catalogLoading} />
    {/if}
  </section>
{:else if session.libraryLevel === "artist" && session.selectedArtist}
  <PageToolbar
    eyebrow={t("page.library.artistEyebrow")}
    title={session.selectedArtist.name}
    back={{
      label: t("page.library.backToArtists"),
      onclick: () => void session.backLibrary(),
    }}
  >
    {#snippet tools()}
      <PlayCollectionButton
        label={t("page.library.playArtist")}
        onclick={() => void session.shuffleArtist()}
      />
      <EntityInfoAction
        artistDir={selectedArtistDir}
        title={session.selectedArtist!.name}
      />
    {/snippet}
  </PageToolbar>
  <section class="rk-surface-card library-page-body">
    <div class="library-filter-panel library-sort-panel library-genre-tracklist-toolbar">
      <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
        <div>
          <h2>
    {tp("library.albumsFound", sortedArtistAlbums.length)}
          </h2>
        </div>
        <div class="section-head__tools library-overview-toolbar">
          <SortSegmented ariaLabel={t("library.sortAlbumsAria")} keys={["date", "name", "plays"]} value={artistAlbumSort} onchange={(v) => (session.artistAlbumSort = v)} />
        </div>
      </div>
    </div>
    <MediaGrid
      kind="album"
      items={artistAlbumItems}
      emptyMessage={t("library.emptyArtistAlbums")}
      onselect={(id) => void selectAlbum(id)}
    />
  </section>
{:else if session.libraryLevel === "album" && session.selectedAlbum}
  <LibraryAlbumDetail album={session.selectedAlbum} />
{:else if session.libraryLevel === "search"}
  <LibrarySearch />
{/if}
</div>

<style>
  .library-page-body {
    min-width: 0;
    padding: var(--rk-space-md) var(--rk-space-lg);
  }

  .library-page-body .library-filter-panel {
    margin-bottom: 0.85rem;
  }

  .genre-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(19rem, 100%), 1fr));
    gap: 0.65rem 0.85rem;
  }

  .library-mood-browse {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .mood-clear {
    border: 1px solid var(--rk-line);
    background: transparent;
    color: var(--rk-muted-strong);
    border-radius: var(--rk-radius);
    padding: 0.3rem 0.65rem;
    font: inherit;
    font-size: var(--rk-fs-xs);
    font-weight: 650;
    cursor: pointer;
  }

  .mood-clear:hover {
    color: var(--rk-ink);
    border-color: color-mix(in srgb, var(--rk-line) 70%, var(--rk-ink) 30%);
  }

  .mood-hint {
    margin: 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
    line-height: var(--rk-lh);
  }

  .mood-pick-hint {
    margin: 0.15rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .mood-results {
    padding: 0.55rem 0 0.75rem;
  }

  .mood-results-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.55rem;
  }

  .library-catalog-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0 0 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid color-mix(in srgb, var(--rk-danger) 45%, var(--rk-line));
    color: var(--rk-ink);
    font-size: var(--rk-fs-sm);
  }
</style>
