<script lang="ts">
  import { onMount } from "svelte";
  import { Button, CoverArt, SectionHeader, TextInput } from "@rekord/ui";
  import EntityInfoAction from "../components/EntityInfoAction.svelte";
  import GenreListTile from "../components/GenreListTile.svelte";
  import MediaGrid from "../components/MediaGrid.svelte";
  import MetaBadgeCluster from "../components/MetaBadgeCluster.svelte";
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import TrackMoodGlyph from "../components/TrackMoodGlyph.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { albumCoverUrl, api, type Track } from "../lib/api";
  import { buildArtistCoverAlbumMap } from "../lib/artistCover";
  import {
    parseTrackGenres,
    serializeTrackGenres,
    trackHasGenre,
  } from "../lib/genres";
  import { t, i18n } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { session, type LibraryBrowse } from "../lib/session.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import {
    GENRE_POOL,
    TRACK_MOOD_COLORS,
    TRACK_MOOD_IDS,
    TRACK_MOOD_LABELS,
    albumGenre,
    albumHasAlbumMeta,
    previewMoods,
    resolveTrackMoods,
    trackGenre,
    trackHasFileMeta,
    trackMatchesMoodFilter,
    trackYear,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Come React `libOverviewSort`: Nome / Ascolti per Artisti e Generi. */
  let overviewSort = $state<"name" | "plays">("name");
  /** Come React `artistAlbumSort`: Data / Nome / Ascolti nella griglia album artista. */
  let artistAlbumSort = $state<"date" | "name" | "plays">("date");
  let artistCoverById = $state<Map<number, number>>(new Map());
  let albumGenrePickerOpen = $state(false);
  let albumGenreBusy = $state(false);
  let albumGenreErr = $state<string | null>(null);
  let albumGenreAddWrapEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    void session.ensureCatalogTracks();
    const onDocPointer = (ev: MouseEvent) => {
      if (!albumGenrePickerOpen) return;
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (albumGenreAddWrapEl?.contains(target)) return;
      albumGenrePickerOpen = false;
    };
    document.addEventListener("mousedown", onDocPointer);
    return () => document.removeEventListener("mousedown", onDocPointer);
  });

  $effect(() => {
    session.artists;
    session.allAlbums;
    artistCoverById = buildArtistCoverAlbumMap(session.artists, session.allAlbums);
  });

  $effect(() => {
    session.selectedAlbum?.id;
    albumGenrePickerOpen = false;
    albumGenreErr = null;
  });

  const browseTabs = $derived([
    { id: "artists", label: t("page.library.tab.artists") },
    { id: "genres", label: t("page.library.tab.genres") },
    { id: "moods", label: t("page.library.tab.moods") },
  ]);

  type SearchFilter = "all" | "artists" | "albums" | "tracks";
  /** Rows per kind when all kinds share the page. */
  const SEARCH_MIXED_CAP = 12;
  /** …and when one kind has the page to itself. */
  const SEARCH_FOCUS_CAP = 60;
  const searchFilters: {
    id: SearchFilter;
    labelKey: string;
    icon: "list" | "person" | "album" | "note";
  }[] = [
    { id: "all", labelKey: "search.filterAll", icon: "list" },
    { id: "artists", labelKey: "search.filterArtists", icon: "person" },
    { id: "albums", labelKey: "search.filterAlbums", icon: "album" },
    { id: "tracks", labelKey: "search.filterTracks", icon: "note" },
  ];
  let searchFilter = $state<SearchFilter>("all");
  let searchWasOpen = false;

  $effect(() => {
    // Each visit to the search page starts from the whole picture; refining the
    // query keeps the chosen kind.
    const open = session.libraryLevel === "search";
    if (open && !searchWasOpen) {
      searchFilter = "all";
      // The search field lives in this view, so whoever opened the page (topbar
      // button, Ctrl+K, `/`) cannot focus it: it does not exist yet at that point.
      document.getElementById("library-search-input")?.focus();
    }
    searchWasOpen = open;
  });

  const genreBuckets = $derived.by(() => {
    const map = new Map<string, { albums: typeof session.allAlbums; count: number }>();
    if (!session.catalogTracks.length) {
      for (const a of session.allAlbums) {
        const g = albumGenre(a) ?? "Senza genere";
        const cur = map.get(g) ?? { albums: [], count: 0 };
        cur.albums.push(a);
        cur.count += a.track_count;
        map.set(g, cur);
      }
    } else {
      const labelByLow = new Map<string, string>();
      const albumIdsByGenre = new Map<string, Set<number>>();
      const trackCountByGenre = new Map<string, number>();
      for (const tr of session.catalogTracks) {
        const genres = parseTrackGenres(tr.genre);
        const keys = genres.length ? genres : ["Senza genere"];
        for (const g of keys) {
          const low = g.toLowerCase();
          if (!labelByLow.has(low)) labelByLow.set(low, g);
          trackCountByGenre.set(low, (trackCountByGenre.get(low) ?? 0) + 1);
          if (tr.album_id != null) {
            const set = albumIdsByGenre.get(low) ?? new Set();
            set.add(tr.album_id);
            albumIdsByGenre.set(low, set);
          }
        }
      }
      for (const [low, ids] of albumIdsByGenre) {
        const name = labelByLow.get(low) ?? low;
        const albums = session.allAlbums.filter((a) => ids.has(a.id));
        map.set(name, {
          albums,
          count: trackCountByGenre.get(low) ?? 0,
        });
      }
    }
    return [...map.entries()].map(([name, v]) => ({
      name,
      albumCount: v.albums.length,
      trackCount: v.count,
      covers: v.albums
        .filter((a) => a.has_cover)
        .slice(0, 4)
        .map((a) => albumCoverUrl(a.id, 128)),
    }));
  });

  /** Chiavi lowercase → ascolti (allineato a parse multi-genere). */
  const playsByGenreName = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    const m = new Map<string, number>();
    for (const tr of session.catalogTracks) {
      const play = player.playCount(tr);
      if (!play) continue;
      const genres = parseTrackGenres(tr.genre);
      const keys = genres.length ? genres : ["Senza genere"];
      for (const g of keys) {
        const low = g.toLowerCase();
        m.set(low, (m.get(low) ?? 0) + play);
      }
    }
    return m;
  });

  const sortedGenreBuckets = $derived.by(() => {
    const list = [...genreBuckets];
    // Match React: "Senza genere" is always pinned first (separate tile before sorted list).
    list.sort((a, b) => {
      if (a.name === "Senza genere") return -1;
      if (b.name === "Senza genere") return 1;
      if (overviewSort === "plays") {
        return (
          (playsByGenreName.get(b.name.toLowerCase()) ?? 0) -
            (playsByGenreName.get(a.name.toLowerCase()) ?? 0) ||
          a.name.localeCompare(b.name)
        );
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  });

  const selectedGenreBucket = $derived(
    session.selectedGenre
      ? (sortedGenreBuckets.find((g) => g.name === session.selectedGenre) ?? null)
      : null,
  );

  /** Come React `sortedGenreTracks`: brani del genere, ordinati per nome o ascolti. */
  const sortedGenreTracks = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    session.selectedGenre;
    overviewSort;
    if (!session.selectedGenre) return [];
    const genre = session.selectedGenre;
    const genreLow = genre.toLowerCase();
    const base = session.catalogTracks.filter((tr) => {
      const genres = parseTrackGenres(tr.genre);
      if (genre === "Senza genere") return genres.length === 0;
      return genres.some((g) => g.toLowerCase() === genreLow);
    });
    if (overviewSort === "plays") {
      base.sort(
        (a, b) =>
          player.playCount(b) - player.playCount(a) ||
          a.artist_name.localeCompare(b.artist_name, undefined, { numeric: true }) ||
          a.album_name.localeCompare(b.album_name, undefined, { numeric: true }) ||
          a.title.localeCompare(b.title, undefined, { numeric: true }),
      );
    } else {
      base.sort(
        (a, b) =>
          a.artist_name.localeCompare(b.artist_name, undefined, { numeric: true }) ||
          a.album_name.localeCompare(b.album_name, undefined, { numeric: true }) ||
          a.title.localeCompare(b.title, undefined, { numeric: true }),
      );
    }
    return base;
  });

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

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void session.searchLibrary(), 200);
  }

  function setBrowse(id: string) {
    session.libraryBrowse = id as LibraryBrowse;
    session.selectedGenre = null;
    session.moodFilterIds = [];
  }

  function toggleMood(id: string) {
    if (session.moodFilterIds.includes(id)) {
      session.moodFilterIds = session.moodFilterIds.filter((x) => x !== id);
    } else {
      session.moodFilterIds = [...session.moodFilterIds, id];
    }
  }

  const moodCounts = $derived.by(() => {
    session.moodPrefsTick;
    session.catalogTracks;
    const prefs = loadUserPrefs().trackMoods;
    const counts = Object.fromEntries(TRACK_MOOD_IDS.map((id) => [id, 0])) as Record<
      TrackMoodId,
      number
    >;
    for (const t of session.catalogTracks) {
      for (const m of resolveTrackMoods(t.id, t.rel_path, prefs)) {
        counts[m] += 1;
      }
    }
    return counts;
  });

  const moodFilteredTracks = $derived.by(() => {
    session.moodPrefsTick;
    session.catalogTracks;
    session.moodFilterIds;
    session.moodMatchAll;
    if (!session.moodFilterIds.length) return [];
    const prefs = loadUserPrefs().trackMoods;
    return session.catalogTracks
      .filter((t) =>
        trackMatchesMoodFilter(
          resolveTrackMoods(t.id, t.rel_path, prefs),
          session.moodFilterIds,
          session.moodMatchAll,
        ),
      )
      .sort(
        (a, b) =>
          a.artist_name.localeCompare(b.artist_name) ||
          a.album_name.localeCompare(b.album_name) ||
          a.title.localeCompare(b.title),
      );
  });

  const albumExcluded = $derived(
    session.selectedAlbum ? player.isAlbumExcluded(session.selectedAlbum.id) : false,
  );

  const albumSeed = $derived(
    session.selectedAlbum
      ? `${session.selectedAlbum.artist_name}/${session.selectedAlbum.name}`
      : "",
  );
  /** Segmenti FS per entity-info (folder_key = "artista/album…"). */
  const albumEntityArtistDir = $derived.by(() => {
    const a = session.selectedAlbum;
    if (!a) return "";
    const head = a.folder_key.split("/")[0]?.trim();
    return head || a.artist_name;
  });
  const albumEntityAlbumDir = $derived.by(() => {
    const a = session.selectedAlbum;
    if (!a) return "";
    const slash = a.folder_key.indexOf("/");
    if (slash >= 0) {
      const rest = a.folder_key.slice(slash + 1).trim();
      if (rest) return rest;
    }
    return a.name;
  });
  const albumYear = $derived(trackYear(null, session.selectedAlbum));
  const albumLabel = $derived(session.selectedAlbum?.label?.trim() || null);

  /** Generi presenti sui brani dell’album (non sul campo album). */
  const albumTrackGenres = $derived.by(() => {
    session.tick;
    const byLower = new Map<string, string>();
    for (const tr of session.tracks) {
      for (const g of parseTrackGenres(tr.genre)) {
        const low = g.toLowerCase();
        if (!byLower.has(low)) byLower.set(low, g);
      }
    }
    return Array.from(byLower.values()).sort((a, b) =>
      a.localeCompare(b, i18n.sortLocale, { numeric: true }),
    );
  });

  const albumTrackGenreCounts = $derived.by(() => {
    session.tick;
    const counts = new Map<string, number>();
    for (const tr of session.tracks) {
      for (const g of parseTrackGenres(tr.genre)) {
        const low = g.toLowerCase();
        counts.set(low, (counts.get(low) ?? 0) + 1);
      }
    }
    return counts;
  });

  /** Generi libreria (o pool) non ancora presenti sull’album — per il picker “+”. */
  const albumGenreOptions = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    const albumKeys = new Set(albumTrackGenres.map((g) => g.toLowerCase()));
    const byLower = new Map<string, string>();
    for (const tr of session.catalogTracks) {
      for (const g of parseTrackGenres(tr.genre)) {
        const low = g.toLowerCase();
        if (!byLower.has(low)) byLower.set(low, g);
      }
    }
    for (const g of GENRE_POOL) {
      const low = g.toLowerCase();
      if (!byLower.has(low)) byLower.set(low, g);
    }
    return Array.from(byLower.values())
      .filter((g) => !albumKeys.has(g.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, i18n.sortLocale, { numeric: true }));
  });

  async function applyAlbumGenreToAllTracks(
    genreToken: string,
    applyMode: "add" | "remove",
    targetTracks: Track[] = session.tracks,
  ) {
    const token = genreToken.trim();
    if (!token || targetTracks.length === 0) return;
    const low = token.toLowerCase();
    albumGenreBusy = true;
    albumGenreErr = null;
    try {
      let changed = 0;
      for (const tr of targetTracks) {
        const cur = parseTrackGenres(tr.genre);
        const has = cur.some((g) => g.toLowerCase() === low);
        if (applyMode === "add" && has) continue;
        if (applyMode === "remove" && !has) continue;
        const next =
          applyMode === "add"
            ? [...cur, token]
            : cur.filter((g) => g.toLowerCase() !== low);
        const nextSerialized = serializeTrackGenres(next);
        await api.trackInfoSave(tr.rel_path, {
          genre: nextSerialized ?? "",
        });
        tr.genre = nextSerialized;
        const cat = session.catalogTracks.find((c) => c.rel_path === tr.rel_path);
        if (cat) cat.genre = nextSerialized;
        changed += 1;
      }
      if (changed) {
        session.tracks = session.tracks.slice();
        session.catalogTracks = session.catalogTracks.slice();
        session.tick += 1;
      }
    } catch (e) {
      albumGenreErr = e instanceof Error ? e.message : String(e);
    } finally {
      albumGenreBusy = false;
    }
  }

  async function addAlbumGenreBySelection(genreToken: string) {
    await applyAlbumGenreToAllTracks(genreToken, "add");
    albumGenrePickerOpen = false;
  }

  async function applyAlbumGenreToMissingTracks(genreToken: string) {
    const token = genreToken.trim();
    if (!token) return;
    const missing = session.tracks.filter((tr) => !trackHasGenre(tr.genre, token));
    if (missing.length === 0) return;
    if (
      !confirm(
        t("albumMeta.addGenreMissingConfirm", { g: token, n: missing.length }),
      )
    ) {
      return;
    }
    await applyAlbumGenreToAllTracks(token, "add", missing);
  }

  async function removeAlbumGenre(genreToken: string) {
    if (
      !confirm(t("albumMeta.removeGenreAllConfirm", { g: genreToken }))
    ) {
      return;
    }
    await applyAlbumGenreToAllTracks(genreToken, "remove");
  }

  /** Come React `AlbumTracklistExpectedMeta`: solo se c’è un conteggio atteso. */
  const albumExpectedTrackCount = $derived.by(() => {
    const n = session.selectedAlbum?.expected_track_count;
    return n != null && n > 0 ? n : null;
  });
  const albumMoods = $derived(albumSeed ? previewMoods(albumSeed) : []);

  const browseIcon = $derived(
    session.libraryBrowse === "artists"
      ? "person"
      : session.libraryBrowse === "genres"
        ? "style"
        : "palette",
  );

  /** The page title says what the active tab is showing, not the tab name. */
  const browseSummary = $derived.by(() => {
    if (session.libraryBrowse === "genres") {
      return t("page.library.summaryGenres", { count: sortedGenreBuckets.length });
    }
    if (session.libraryBrowse === "moods") {
      return t("page.library.summaryMoods");
    }
    return t("page.library.summaryArtists", {
      artists: session.artists.length,
      albums: session.allAlbums.length,
    });
  });

  const sortedArtists = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    const list = [...session.artists];
    if (overviewSort === "plays") {
      list.sort((a, b) => {
        const pa = session.catalogTracks
          .filter((t) => t.artist_id === a.id)
          .reduce((sum, t) => sum + player.playCount(t), 0);
        const pb = session.catalogTracks
          .filter((t) => t.artist_id === b.id)
          .reduce((sum, t) => sum + player.playCount(t), 0);
        return pb - pa || a.name.localeCompare(b.name);
      });
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  });

  const sortedArtistAlbums = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    const list = [...session.albums];
    if (artistAlbumSort === "date") {
      list.sort((a, b) => {
        const da = trackYear(null, a) ?? "";
        const db = trackYear(null, b) ?? "";
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
      const albumPlays = (albumId: number) =>
        session.catalogTracks
          .filter((t) => t.album_id === albumId)
          .reduce((sum, t) => sum + player.playCount(t), 0);
      list.sort(
        (a, b) =>
          albumPlays(b.id) - albumPlays(a.id) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    }
    return list;
  });
</script>

<div class="view-page library-page">
{#if session.libraryLevel === "artists"}
  {#if session.libraryBrowse === "genres" && session.selectedGenre}
    <PageToolbar
      eyebrow={t("page.library.genreEyebrow")}
      title={session.selectedGenre}
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
    {#if session.libraryBrowse === "genres" && session.selectedGenre}
      <div class="library-filter-panel library-filter-panel--tight library-sort-panel library-genre-tracklist-toolbar">
        <div class="section-head section-head--page-toolbar">
          <div>
            <p class="rk-eyebrow">Tracklist</p>
            <h2>
              {selectedGenreBucket?.albumCount ?? 0} album · {sortedGenreTracks.length}
              {sortedGenreTracks.length === 1 ? " brano" : " brani"}
            </h2>
          </div>
          <div class="section-head__tools">
            <div
              class="segmented--joined"
              role="group"
              aria-label="Ordina per nome o per numero di ascolti"
            >
              <button
                type="button"
                class:is-on={overviewSort === "name"}
                onclick={() => (overviewSort = "name")}
              >
                <span class="segmented__btn-inner">
                  <UiIcon name="sortByAlpha" class="segmented__ic" />
                  <span>Nome</span>
                </span>
              </button>
              <button
                type="button"
                class:is-on={overviewSort === "plays"}
                onclick={() => (overviewSort = "plays")}
              >
                <span class="segmented__btn-inner">
                  <UiIcon name="chart" class="segmented__ic" />
                  <span>Ascolti</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    {:else if session.libraryBrowse === "artists" || session.libraryBrowse === "genres"}
      <div class="library-filter-panel library-sort-panel library-genre-tracklist-toolbar">
        <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
          <div>
            <h2>
              {#if session.libraryBrowse === "artists"}
                {sortedArtists.length}
                {sortedArtists.length === 1 ? "artista trovato" : "artisti trovati"}
              {:else}
                {sortedGenreBuckets.length}
                {sortedGenreBuckets.length === 1 ? "genere trovato" : "generi trovati"}
              {/if}
            </h2>
          </div>
          <div class="section-head__tools library-overview-toolbar">
            <div
              class="segmented--joined"
              role="group"
              aria-label="Ordina per nome o per numero di ascolti"
            >
              <button
                type="button"
                class:is-on={overviewSort === "name"}
                onclick={() => (overviewSort = "name")}
              >
                <span class="segmented__btn-inner">
                  <UiIcon name="sortByAlpha" class="segmented__ic" />
                  <span>Nome</span>
                </span>
              </button>
              <button
                type="button"
                class:is-on={overviewSort === "plays"}
                onclick={() => (overviewSort = "plays")}
              >
                <span class="segmented__btn-inner">
                  <UiIcon name="chart" class="segmented__ic" />
                  <span>Ascolti</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if session.libraryBrowse === "artists"}
      <MediaGrid
        kind="artist"
        items={sortedArtists.map((a) => {
          session.tick;
          const coverAlbumId = artistCoverById.get(a.id);
          const albums = session.allAlbums.filter((al) => al.artist_id === a.id);
          const tracks = session.catalogTracks.filter((t) => t.artist_id === a.id);
          const albumsEx = albums.filter((al) => player.isAlbumExcluded(al.id)).length;
          let trackEx = 0;
          for (const t of tracks) {
            if (t.album_id != null && player.isAlbumExcluded(t.album_id)) {
              trackEx += 1;
              continue;
            }
            if (player.getExcludedRelPaths().has(t.rel_path)) trackEx += 1;
          }
          return {
            id: a.id,
            title: a.name,
            subtitle: `${a.album_count} album · ${a.track_count} brani`,
            coverSrc: coverAlbumId != null ? albumCoverUrl(coverAlbumId, 256) : "",
            coverSeed: a.name,
            favoriteCount: session.favorites.filter((t) => t.artist_id === a.id).length,
            albumsMissingMetaCount: albums.filter(
              (al) => !al.loose && !albumHasAlbumMeta(al),
            ).length,
            tracksMissingMetaCount: tracks.filter((tr) => !trackHasFileMeta(tr)).length,
            albumsExcludedCount: albumsEx,
            tracksExcludedCount: trackEx,
          };
        })}
        emptyMessage="Nessun artista — esegui uno scan dal server"
        onselect={(id) => void selectArtist(id)}
      />
    {:else if session.libraryBrowse === "genres"}
      {#if session.selectedGenre}
        <TrackList
          tracks={sortedGenreTracks}
          favoriteIds={session.favoriteIds}
          playlistOptions={session.playlistOptions}
          activeTrackId={session.current?.id ?? null}
          emptyMessage="Nessun brano in questo genere"
          onplay={(track, list) => session.playCollectionShuffle(track, list)}
          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
          onaddToPlaylist={(playlistId, track) =>
            void session.addToPlaylist(playlistId, track.id)}
        />
      {:else}
        <div class="genre-list">
          {#each sortedGenreBuckets as g}
            <GenreListTile
              title={g.name}
              albumCount={g.albumCount}
              trackCount={g.trackCount}
              coverSlots={g.covers}
              onclick={() => {
                void session.ensureCatalogTracks();
                session.selectedGenre = g.name;
              }}
            />
          {/each}
        </div>
      {/if}
    {:else if session.libraryBrowse === "moods"}
      <div class="library-mood-browse">
        <div class="library-mood-toolbar">
          <div class="library-mood-match-row">
            <span class="rk-eyebrow library-mood-match-label">Combinazione</span>
            <div class="match-underline" role="group" aria-label="Modalità filtro mood">
              <button
                type="button"
                class:is-on={!session.moodMatchAll}
                title="Brani con almeno uno dei mood scelti"
                onclick={() => (session.moodMatchAll = false)}
              >
                Almeno uno
              </button>
              <button
                type="button"
                class:is-on={session.moodMatchAll}
                title="Brani che hanno tutti i mood scelti"
                onclick={() => (session.moodMatchAll = true)}
              >
                Tutti
              </button>
            </div>
            {#if session.moodFilterIds.length}
              <button
                type="button"
                class="mood-clear"
                onclick={() => (session.moodFilterIds = [])}
              >
                Azzera
              </button>
            {/if}
          </div>
          <p class="mood-hint">
            Tocca i mood per filtrare · i numeri sono i brani in libreria
          </p>
        </div>
        <div class="library-mood-filter-grid">
          {#each TRACK_MOOD_IDS as id}
            {@const count = moodCounts[id]}
            {@const on = session.moodFilterIds.includes(id)}
            <button
              type="button"
              class="library-mood-filter-btn"
              class:library-mood-filter-btn--on={on}
              style="--mood-c:{TRACK_MOOD_COLORS[id]}"
              disabled={count === 0 && !on}
              title={TRACK_MOOD_LABELS[id]}
              aria-pressed={on}
              aria-label={TRACK_MOOD_LABELS[id]}
              onclick={() => {
                void session.ensureCatalogTracks();
                toggleMood(id);
              }}
            >
              <span class="library-mood-filter-btn__glyph-row">
                <TrackMoodGlyph mood={id} inheritColor />
                <span class="library-mood-filter-btn__count">{count}</span>
              </span>
            </button>
          {/each}
        </div>

        {#if session.moodFilterIds.length}
          <div class="mood-results">
            <div class="mood-results-head">
              <SectionHeadLead
                eyebrow="Risultati"
                title={`${moodFilteredTracks.length} brani`}
              >
                <UiIcon name="music" />
              </SectionHeadLead>
              <PlayCollectionButton
                label="Ascolta"
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
          <p class="mood-pick-hint">Seleziona almeno un mood per vedere i brani.</p>
        {/if}
      </div>
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
        artistDir={session.selectedArtist!.name}
        title={session.selectedArtist!.name}
      />
    {/snippet}
  </PageToolbar>
  <section class="rk-surface-card library-page-body">
    <div class="library-filter-panel library-sort-panel library-genre-tracklist-toolbar">
      <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
        <div>
          <h2>
            {sortedArtistAlbums.length}
            {sortedArtistAlbums.length === 1 ? "album trovato" : "album trovati"}
          </h2>
        </div>
        <div class="section-head__tools library-overview-toolbar">
          <div
            class="segmented--joined"
            role="group"
            aria-label="Ordina album: data, nome o ascolti"
          >
            <button
              type="button"
              class:is-on={artistAlbumSort === "date"}
              onclick={() => (artistAlbumSort = "date")}
            >
              <span class="segmented__btn-inner">
                <UiIcon name="date" class="segmented__ic" />
                <span>Data</span>
              </span>
            </button>
            <button
              type="button"
              class:is-on={artistAlbumSort === "name"}
              onclick={() => (artistAlbumSort = "name")}
            >
              <span class="segmented__btn-inner">
                <UiIcon name="sortByAlpha" class="segmented__ic" />
                <span>Nome</span>
              </span>
            </button>
            <button
              type="button"
              class:is-on={artistAlbumSort === "plays"}
              onclick={() => (artistAlbumSort = "plays")}
            >
              <span class="segmented__btn-inner">
                <UiIcon name="chart" class="segmented__ic" />
                <span>Ascolti</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <MediaGrid
      kind="album"
      items={sortedArtistAlbums.map((a) => {
        session.tick;
        const tracks = session.catalogTracks.filter((t) => t.album_id === a.id);
        const albumEx = player.isAlbumExcluded(a.id);
        const excludedPaths = player.getExcludedRelPaths();
        const trackEx = tracks.filter((t) => excludedPaths.has(t.rel_path)).length;
        const year = trackYear(null, a);
        return {
          id: a.id,
          title: a.name,
          /* Come AlbumListTile artista React: niente riga artista (già nel contesto) */
          metaLine: `${a.track_count} brani${year ? ` · ${year}` : ""}`,
          coverSrc: a.has_cover ? albumCoverUrl(a.id, 256) : "",
          coverSeed: `${session.selectedArtist?.name}/${a.name}`,
          favoriteCount: session.favorites.filter((t) => t.album_id === a.id).length,
          tracksMissingMetaCount: tracks.filter((tr) => !trackHasFileMeta(tr)).length,
          genreMissing: !albumHasAlbumMeta(a),
          albumExcluded: albumEx,
          tracksExcludedCount: albumEx ? a.track_count : trackEx,
          loose: a.loose,
        };
      })}
      emptyMessage="Nessun album in questa cartella artista"
      onselect={(id) => void selectAlbum(id)}
    />
  </section>
{:else if session.libraryLevel === "album" && session.selectedAlbum}
  {@const albumFavCount = session.favorites.filter(
    (t) => t.album_id === session.selectedAlbum!.id,
  ).length}
  <section class="album-hero rk-surface-card">
    <div class="album-hero__body">
      <div class="album-hero__top-band">
        <button
          type="button"
          class="album-hero__cover-btn"
          title="Modifica cover"
          aria-label="Carica copertina album"
          onclick={() => session.openCoverEdit()}
        >
          <CoverArt
            title={session.selectedAlbum.name}
            seed={albumSeed}
            src={session.selectedAlbum.has_cover
              ? albumCoverUrl(session.selectedAlbum.id)
              : ""}
            size="xl"
          />
          <span class="album-hero__cover-edit-badge" aria-hidden="true">
            <UiIcon name="image" />
          </span>
        </button>

        <div class="album-hero__top-right">
          <div class="section-head section-head--page-toolbar album-hero__toprow">
            <div class="page-toolbar__lead page-toolbar__lead--backrow">
              <button
                type="button"
                class="page-toolbar-back-ic"
                aria-label="Torna all'artista"
                onclick={() => void session.backLibrary()}
              >
                <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
              </button>
              <div class="page-toolbar__textcol album-hero__toolbar-text">
                <p class="rk-eyebrow">Dettaglio album</p>
                <MetaBadgeCluster
                  variant="hero"
                  missingMeta={!albumHasAlbumMeta(session.selectedAlbum)}
                  tracksMissingMetaCount={session.tracks.filter(
                    (tr) => !trackHasFileMeta(tr),
                  ).length}
                  favoriteCount={albumFavCount}
                  albumExcluded={albumExcluded}
                  tracksExcludedCount={albumExcluded
                    ? session.selectedAlbum.track_count
                    : session.tracks.filter((tr) =>
                        player.getExcludedRelPaths().has(tr.rel_path),
                      ).length}
                  loose={session.selectedAlbum.loose}
                />
              </div>
            </div>
            <div class="section-head__tools page-toolbar__actions">
              <Button onclick={() => session.playSequence(session.tracks, 0)}>Riproduci album</Button>
              <EntityInfoAction
                artistDir={albumEntityArtistDir}
                albumDir={albumEntityAlbumDir}
                title={session.selectedAlbum.name}
              />
              <Button variant="ghost" onclick={() => session.openAlbumEdit()} aria-label="Modifica album">
                <UiIcon name="edit" />
              </Button>
              <Button
                variant="ghost"
                onclick={() => player.toggleExcludeAlbum(session.selectedAlbum!.id)}
                aria-pressed={albumExcluded}
                aria-label="Blocchi shuffle"
                title="Blocchi shuffle"
              >
                <UiIcon name="exclude" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div class="album-hero__titleblock">
        <h1 class="album-hero__h1">{session.selectedAlbum.name}</h1>
      </div>

      <div class="album-hero__meta-full">
        <p class="album-hero__title-meta">
          <button
            type="button"
            class="album-hero__artist-link"
            onclick={() => void session.backLibrary()}
          >
            {session.selectedAlbum.artist_name}
          </button>
          {#if albumYear}<span>· {albumYear}</span>{/if}
          {#if albumLabel}<span>· {albumLabel}</span>{/if}
        </p>
        <div class="album-hero__genres" role="list">
          {#each albumTrackGenres as g (g.toLowerCase())}
            {@const genreCount = albumTrackGenreCounts.get(g.toLowerCase()) ?? 0}
            <span class="album-hero__genre-chip" role="listitem">
              <button
                type="button"
                class="album-hero__genre-chip__text"
                disabled={albumGenreBusy}
                title={t("albumMeta.applyGenreMissingTitle", {
                  g,
                  n: genreCount,
                  total: session.tracks.length,
                })}
                onclick={() => void applyAlbumGenreToMissingTracks(g)}
              >
                {g} ({genreCount})
              </button>
              <button
                type="button"
                class="album-hero__genre-chip__x"
                disabled={albumGenreBusy}
                aria-label={t("trackMeta.fieldGenreRemoveAria", { g })}
                onclick={() => void removeAlbumGenre(g)}
              >
                <UiIcon name="close" class="album-hero__genre-chip__x-ic" />
              </button>
            </span>
          {/each}
          {#if albumGenreOptions.length > 0}
            <div class="album-hero__genre-add-wrap" bind:this={albumGenreAddWrapEl}>
              <button
                type="button"
                class="album-hero__genre-add"
                disabled={albumGenreBusy}
                aria-expanded={albumGenrePickerOpen}
                aria-label={t("trackMeta.fieldGenreAdd")}
                title={t("trackMeta.fieldGenreAdd")}
                onclick={(e) => {
                  e.stopPropagation();
                  albumGenrePickerOpen = !albumGenrePickerOpen;
                }}
              >
                <UiIcon name="add" class="album-hero__genre-add-ic" />
              </button>
              {#if albumGenrePickerOpen}
                <ul class="track-row__overflow-menu album-hero__genre-menu rk-scroll" role="menu">
                  {#each albumGenreOptions as opt (opt.toLowerCase())}
                    <li role="presentation">
                      <button
                        type="button"
                        role="menuitem"
                        class="track-row__overflow-item"
                        onclick={() => void addAlbumGenreBySelection(opt)}
                      >
                        <span class="track-row__overflow-item-glyph" aria-hidden="true">
                          <UiIcon name="style" />
                        </span>
                        <span class="track-row__overflow-item-label">{opt}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
          {#if albumGenreErr}
            <p class="album-hero__genre-err" role="alert">{albumGenreErr}</p>
          {/if}
        </div>
      </div>
    </div>
  </section>

  <section class="album-hero__tracks rk-surface-card">
    <div class="tracklist-head">
      <SectionHeadLead eyebrow="Tracklist" title={`${session.tracks.length} brani`}>
        <UiIcon name="music" />
      </SectionHeadLead>
      {#if albumExpectedTrackCount != null && albumExpectedTrackCount > 0}
        <div class="album-tracklist-expected">
          <UiIcon name="queueMusic" class="album-tracklist-expected__ic" />
          <span class="album-tracklist-expected__ratio" aria-hidden="true">
            {session.tracks.length}/{albumExpectedTrackCount}
          </span>
        </div>
      {/if}
    </div>
    <TrackList
      tracks={session.tracks}
      favoriteIds={session.favoriteIds}
      playlistOptions={session.playlistOptions}
      activeTrackId={session.current?.id ?? null}
      onplay={(track, list) => {
        const idx = list.findIndex((t) => t.id === track.id);
        session.playSequence(list, idx >= 0 ? idx : 0);
      }}
      ontoggleFavorite={(track) => void session.toggleFavorite(track)}
      onaddToPlaylist={(playlistId, track) =>
        void session.addToPlaylist(playlistId, track.id)}
    />
  </section>
{:else if session.libraryLevel === "search"}
  {@const q = session.query.trim()}
  {@const hitArtists = session.matchArtists(q)}
  {@const hitAlbums = session.matchAlbums(q)}
  {@const showArtists = searchFilter === "all" || searchFilter === "artists"}
  {@const showAlbums = searchFilter === "all" || searchFilter === "albums"}
  {@const showTracks = searchFilter === "all" || searchFilter === "tracks"}
  {@const artistCap = searchFilter === "artists" ? SEARCH_FOCUS_CAP : SEARCH_MIXED_CAP}
  {@const albumCap = searchFilter === "albums" ? SEARCH_FOCUS_CAP : SEARCH_MIXED_CAP}
  {@const nothingFound =
    hitArtists.length === 0 && hitAlbums.length === 0 && session.tracks.length === 0}

  <PageToolbar
    eyebrow={t("search.eyebrow")}
    title={t("search.heading")}
    back={{ label: t("search.close"), onclick: () => void session.backLibrary() }}
  >
    {#snippet tools()}
      <div class="search-field">
        <TextInput
          id="library-search-input"
          type="search"
          bind:value={session.query}
          placeholder={t("search.placeholder")}
          oninput={onSearchInput}
          onkeydown={(e) => e.key === "Enter" && void session.searchLibrary()}
        />
      </div>
    {/snippet}
  </PageToolbar>

  <section class="rk-surface-card library-page-body library-search-results">
    {#if !q}
      <p class="search-hint">{t("search.hint")}</p>
    {:else}
      <div class="library-filter-panel library-filter-panel--tight search-filter-panel">
        <div class="segmented--joined" role="group" aria-label={t("search.filterAria")}>
          {#each searchFilters as filter (filter.id)}
            <button
              type="button"
              class:is-on={searchFilter === filter.id}
              onclick={() => (searchFilter = filter.id)}
            >
              <span class="segmented__btn-inner">
                <UiIcon name={filter.icon} class="segmented__ic" />
                <span>{t(filter.labelKey)}</span>
                {#if filter.id !== "all"}
                  <span class="search-filter__count">
                    {filter.id === "artists"
                      ? hitArtists.length
                      : filter.id === "albums"
                        ? hitAlbums.length
                        : session.tracks.length}
                  </span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
      {#if nothingFound}
        <p class="search-hint">{t("search.emptyAll", { query: q })}</p>
      {/if}
      {#if showArtists}
        <section class="search-block">
          <SectionHeader
            title={t("search.filterArtists")}
            subtitle={t("search.results", { count: hitArtists.length })}
          />
          <MediaGrid
            items={hitArtists.slice(0, artistCap).map((a) => ({
              id: a.id,
              title: a.name,
              subtitle: `${a.album_count} album · ${a.track_count} brani`,
              coverSrc: artistCoverById.has(a.id)
                ? albumCoverUrl(artistCoverById.get(a.id)!, 256)
                : "",
              coverSeed: a.name,
            }))}
            emptyMessage={t("search.emptyArtists")}
            onselect={(id) => void selectArtist(id)}
          />
        </section>
      {/if}
      {#if showAlbums}
        <section class="search-block">
          <SectionHeader
            title={t("search.filterAlbums")}
            subtitle={t("search.results", { count: hitAlbums.length })}
          />
          <MediaGrid
            items={hitAlbums.slice(0, albumCap).map((a) => ({
              id: a.id,
              title: a.name,
              subtitle: a.artist_name,
              coverSrc: a.has_cover ? albumCoverUrl(a.id, 256) : "",
              coverSeed: `${a.artist_name}/${a.name}`,
            }))}
            emptyMessage={t("search.emptyAlbums")}
            onselect={(id) => void selectAlbum(id)}
          />
        </section>
      {/if}
      {#if showTracks}
        <section class="search-block">
          <SectionHeader
            title={t("search.filterTracks")}
            subtitle={t("search.results", { count: session.tracks.length })}
          />
          <TrackList
            tracks={session.tracks}
            favoriteIds={session.favoriteIds}
            playlistOptions={session.playlistOptions}
            activeTrackId={session.current?.id ?? null}
            emptyMessage={t("search.emptyTracks")}
            onplay={(track) => void session.playGlobalRadio(track)}
            ontoggleFavorite={(track) => void session.toggleFavorite(track)}
            onaddToPlaylist={(playlistId, track) =>
              void session.addToPlaylist(playlistId, track.id)}
          />
        </section>
      {/if}
    {/if}
  </section>
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

  .library-mood-toolbar {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .library-mood-match-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem 0.95rem;
  }

  .library-mood-match-label {
    flex: 0 0 auto;
    margin: 0;
  }

  .mood-clear {
    margin-left: auto;
    border: 1px solid var(--rk-line);
    background: transparent;
    color: var(--rk-muted-strong);
    border-radius: var(--rk-radius);
    padding: 0.3rem 0.65rem;
    font: inherit;
    font-size: var(--rk-fs-2xs);
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

  .library-mood-filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(4.6rem, 100%), 1fr));
    gap: 0.45rem;
  }

  .mood-results {
    padding: 0.55rem 0.65rem 0.75rem;
  }

  .mood-results-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.55rem;
  }

  .nebula {
    padding: 0;
  }

  .nebula-head {
    display: flex;
    gap: 0.65rem;
    margin-bottom: 0.85rem;
  }

  .nebula-head :global(svg) {
    color: var(--rk-accent-2);
  }

  .nebula-head h3 {
    margin: 0.1rem 0 0;
    font-size: var(--rk-fs-base);
  }

  .nebula-canvas {
    position: relative;
    height: 16rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid var(--rk-line);
    overflow: hidden;
    background:
      radial-gradient(ellipse at 50% 55%, color-mix(in srgb, var(--rk-accent-2) 12%, transparent), transparent 55%),
      radial-gradient(ellipse at 30% 40%, color-mix(in srgb, var(--rk-accent) 10%, transparent), transparent 45%),
      linear-gradient(180deg, #070b12, #0d1420);
  }

  .star {
    position: absolute;
    left: var(--x);
    top: var(--y);
    width: var(--s);
    height: var(--s);
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 8px var(--c);
    animation: twinkle 2.2s ease-in-out infinite alternate;
    animation-delay: var(--d);
  }

  .nebula-core {
    position: absolute;
    left: 50%;
    top: 52%;
    width: 4.5rem;
    height: 4.5rem;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--rk-accent-2) 55%, white), transparent 70%);
    filter: blur(2px);
    opacity: 0.7;
  }

  @keyframes twinkle {
    from {
      opacity: 0.35;
      transform: scale(0.85);
    }
    to {
      opacity: 1;
      transform: scale(1.15);
    }
  }

  /* Parità old album-tracklist-head / page-toolbar */
  .tracklist-head {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.65rem 1.25rem;
    width: 100%;
    padding: 0;
    margin: 0 0 var(--rk-space-md);
  }

  .album-tracklist-expected {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    margin-left: auto;
    padding-top: 0.15rem;
    font-size: var(--rk-fs-md);
    line-height: var(--rk-lh-snug);
    color: var(--rk-muted);
  }

  .album-tracklist-expected :global(.album-tracklist-expected__ic) {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    opacity: 0.88;
  }

  .album-tracklist-expected__ratio {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    opacity: 0.94;
  }

  .library-search-results {
    min-width: 0;
  }

  .search-field {
    display: flex;
    flex: 0 1 22rem;
    align-items: center;
    min-width: 0;
  }

  .search-hint {
    color: var(--rk-muted);
    margin: 0.25rem 0 0;
  }

  .search-filter-panel {
    display: flex;
    justify-content: flex-start;
  }

  /* Hit count inside the segment, so the filter row doubles as a summary. */
  .search-filter-panel :global(.search-filter__count) {
    padding: 0.05rem 0.32rem;
    border-radius: var(--rk-radius-round);
    background: color-mix(in srgb, var(--rk-surface-3) 70%, transparent);
    font-size: var(--rk-fs-3xs);
    font-variant-numeric: tabular-nums;
    color: var(--rk-muted);
  }

  .search-filter-panel :global(button.is-on .search-filter__count) {
    background: color-mix(in srgb, var(--rk-accent) 30%, transparent);
    color: var(--rk-text);
  }

  .search-block {
    margin-bottom: 0.85rem;
  }

  .search-block:last-child {
    margin-bottom: 0;
  }

  @media (max-width: 719.98px) {
    .search-field {
      flex: 1 1 100%;
    }
  }
</style>
