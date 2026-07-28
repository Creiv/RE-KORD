<script lang="ts">
  import { onMount } from "svelte";
  import { Button, CoverArt, SectionHeader, TextInput } from "@rekord/ui";
  import EntityInfoAction from "../components/EntityInfoAction.svelte";
  import GenreListTile from "../components/GenreListTile.svelte";
  import MediaGrid from "../components/MediaGrid.svelte";
  import MetaBadgeCluster from "../components/MetaBadgeCluster.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import SectionNavTabs from "../components/SectionNavTabs.svelte";
  import TrackList from "../components/TrackList.svelte";
  import TrackMoodGlyph from "../components/TrackMoodGlyph.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { albumCoverUrl, api } from "../lib/api";
  import { buildArtistCoverAlbumMap } from "../lib/artistCover";
  import { player } from "../lib/player";
  import { session, type LibraryBrowse } from "../lib/session.svelte";
  import {
    TRACK_MOOD_COLORS,
    TRACK_MOOD_IDS,
    TRACK_MOOD_LABELS,
    previewGenre,
    previewLabel,
    previewMoods,
    previewYear,
    resolveTrackMoods,
    trackMatchesMoodFilter,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Come React `libOverviewSort`: Nome / Ascolti per Artisti e Generi. */
  let overviewSort = $state<"name" | "plays">("name");
  /** Come React `artistAlbumSort`: Data / Nome / Ascolti nella griglia album artista. */
  let artistAlbumSort = $state<"date" | "name" | "plays">("date");
  let artistCoverById = $state<Map<number, number>>(new Map());

  onMount(() => {
    void session.ensureCatalogTracks();
  });

  $effect(() => {
    session.artists;
    session.allAlbums;
    artistCoverById = buildArtistCoverAlbumMap(session.artists, session.allAlbums);
  });

  const browseTabs = [
    { id: "artists", label: "Artisti" },
    { id: "genres", label: "Generi" },
    { id: "moods", label: "Mood" },
    { id: "nebula", label: "Nebula" },
  ];

  const genreBuckets = $derived.by(() => {
    const map = new Map<string, { albums: typeof session.allAlbums; count: number }>();
    for (const a of session.allAlbums) {
      const g = previewGenre(`${a.artist_name}/${a.name}`) ?? "Senza genere";
      const cur = map.get(g) ?? { albums: [], count: 0 };
      cur.albums.push(a);
      cur.count += a.track_count;
      map.set(g, cur);
    }
    return [...map.entries()].map(([name, v]) => ({
      name,
      albumCount: v.albums.length,
      trackCount: v.count,
      covers: v.albums
        .filter((a) => a.has_cover)
        .slice(0, 4)
        .map((a) => albumCoverUrl(a.id)),
    }));
  });

  const playsByGenreName = $derived.by(() => {
    session.tick;
    session.catalogTracks;
    session.allAlbums;
    const albumGenre = new Map<number, string>();
    for (const a of session.allAlbums) {
      albumGenre.set(a.id, previewGenre(`${a.artist_name}/${a.name}`) ?? "Senza genere");
    }
    const m = new Map<string, number>();
    for (const t of session.catalogTracks) {
      const play = player.playCount(t);
      if (!play) continue;
      const g =
        (t.album_id != null ? albumGenre.get(t.album_id) : undefined) ??
        previewGenre(t.rel_path) ??
        "Senza genere";
      m.set(g, (m.get(g) ?? 0) + play);
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
          (playsByGenreName.get(b.name) ?? 0) - (playsByGenreName.get(a.name) ?? 0) ||
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
    session.allAlbums;
    session.selectedGenre;
    overviewSort;
    if (!session.selectedGenre) return [];
    const albumGenre = new Map<number, string>();
    for (const a of session.allAlbums) {
      albumGenre.set(a.id, previewGenre(`${a.artist_name}/${a.name}`) ?? "Senza genere");
    }
    const genre = session.selectedGenre;
    const base = session.catalogTracks.filter((t) => {
      const g =
        (t.album_id != null ? albumGenre.get(t.album_id) : undefined) ??
        previewGenre(t.rel_path) ??
        "Senza genere";
      return g === genre;
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
      session.error = "";
      const artist = await api.artist(Number(id));
      await session.openArtist(artist);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    }
  }

  async function selectAlbum(id: number | string) {
    try {
      session.error = "";
      const album = await api.album(Number(id));
      await session.openAlbum(album);
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
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
  const albumYear = $derived(albumSeed ? previewYear(albumSeed) : null);
  const albumLabel = $derived(albumSeed ? previewLabel(albumSeed) : null);
  const albumGenre = $derived(albumSeed ? previewGenre(albumSeed) : null);
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
        : session.libraryBrowse === "nebula"
          ? "sparkle"
          : "palette",
  );

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
        const da = previewYear(`${a.artist_name}/${a.name}`) ?? "";
        const db = previewYear(`${b.artist_name}/${b.name}`) ?? "";
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

{#if session.libraryLevel === "artists"}
  <section class="rk-surface-card surface-card--toolbar-only lib-chrome">
    <div class="section-head section-head--page-toolbar">
      {#if session.libraryBrowse === "genres" && session.selectedGenre}
        <div class="page-toolbar__lead page-toolbar__lead--backrow">
          <button
            type="button"
            class="page-toolbar-back-ic"
            aria-label="Torna ai generi"
            onclick={() => (session.selectedGenre = null)}
          >
            <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
          </button>
          <div class="page-toolbar__textcol">
            <p class="rk-eyebrow">Genere</p>
            <h2>{session.selectedGenre}</h2>
          </div>
        </div>
        <div class="section-head__tools">
          <div class="hero-card__actions">
            <PlayCollectionButton
              label="Riproduci genere"
              disabled={!sortedGenreTracks.length}
              onclick={() => session.playShuffled(sortedGenreTracks)}
            />
          </div>
        </div>
      {:else}
        <div class="section-head__lead">
          <span class="section-head__icon-wrap" aria-hidden="true">
            <UiIcon name={browseIcon} />
          </span>
          <div class="section-head__text">
            <p class="rk-eyebrow">Panoramica libreria</p>
            <SectionNavTabs
              tabs={browseTabs}
              active={session.libraryBrowse}
              ariaLabel="Sezioni libreria"
              onselect={setBrowse}
            />
          </div>
        </div>
        <div class="section-head__tools">
          <div class="hero-card__actions">
            <PlayCollectionButton
              label="Riproduci tutto"
              onclick={() => void session.shuffleLibrary()}
            />
          </div>
        </div>
      {/if}
    </div>
  </section>

  <section
    class="rk-surface-card library-page-body"
    class:surface-card--nebula={session.libraryBrowse === "nebula"}
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
            coverSrc: coverAlbumId != null ? albumCoverUrl(coverAlbumId) : "",
            coverSeed: a.name,
            favoriteCount: session.favorites.filter((t) => t.artist_id === a.id).length,
            albumsMissingMetaCount: albums.filter(
              (al) => !previewGenre(`${al.artist_name}/${al.name}`),
            ).length,
            tracksMissingMetaCount: tracks.filter((t) => !previewGenre(t.rel_path)).length,
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
          onplay={(track, list) => session.playShuffled(list, track)}
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
                onclick={() => session.playShuffled(moodFilteredTracks)}
              />
            </div>
            <TrackList
              tracks={moodFilteredTracks}
              favoriteIds={session.favoriteIds}
              playlistOptions={session.playlistOptions}
              activeTrackId={session.current?.id ?? null}
              onplay={(track, list) => session.playTrack(track, list)}
              ontoggleFavorite={(track) => void session.toggleFavorite(track)}
              onaddToPlaylist={(playlistId, track) =>
                void session.addToPlaylist(playlistId, track.id)}
            />
          </div>
        {:else}
          <p class="mood-pick-hint">Seleziona almeno un mood per vedere i brani.</p>
        {/if}
      </div>
    {:else}
      <div class="nebula">
        <header class="nebula-head">
          <UiIcon name="sparkle" />
          <div>
            <p class="rk-eyebrow">Nebula</p>
            <h3>L'universo della tua musica</h3>
          </div>
        </header>
        <div class="nebula-canvas" aria-hidden="true">
          {#each Array(48) as _, i}
            <span
              class="star"
              style="--x:{(i * 37) % 100}%; --y:{(i * 53) % 100}%; --s:{3 + (i % 5)}px; --c:{TRACK_MOOD_COLORS[TRACK_MOOD_IDS[i % TRACK_MOOD_IDS.length]]}; --d:{i * 0.04}s"
            ></span>
          {/each}
          <div class="nebula-core"></div>
        </div>
        <p class="mood-hint">Mappa sonora interattiva — modulo Nebula in arrivo.</p>
      </div>
    {/if}
  </section>
{:else if session.libraryLevel === "artist" && session.selectedArtist}
  <section class="rk-surface-card surface-card--toolbar-only lib-chrome">
    <div class="section-head section-head--page-toolbar">
      <div class="page-toolbar__lead page-toolbar__lead--backrow">
        <button
          type="button"
          class="page-toolbar-back-ic"
          aria-label="Torna a tutti gli artisti"
          onclick={() => void session.backLibrary()}
        >
          <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
        </button>
        <div class="page-toolbar__textcol">
          <p class="rk-eyebrow">Artista</p>
          <h2>{session.selectedArtist.name}</h2>
        </div>
      </div>
      <div class="section-head__tools">
        <div class="hero-card__actions">
          <PlayCollectionButton
            label="Riproduci artista"
            onclick={() => void session.shuffleArtist()}
          />
          <EntityInfoAction
            artistDir={session.selectedArtist.name}
            title={session.selectedArtist.name}
          />
        </div>
      </div>
    </div>
  </section>
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
        const year = previewYear(`${a.artist_name}/${a.name}`);
        return {
          id: a.id,
          title: a.name,
          /* Come AlbumListTile artista React: niente riga artista (già nel contesto) */
          metaLine: `${a.track_count} brani${year ? ` · ${year}` : ""}`,
          coverSrc: a.has_cover ? albumCoverUrl(a.id) : "",
          coverSeed: `${session.selectedArtist?.name}/${a.name}`,
          favoriteCount: session.favorites.filter((t) => t.album_id === a.id).length,
          tracksMissingMetaCount: tracks.filter((t) => !previewGenre(t.rel_path)).length,
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
                  missingMeta={!albumGenre}
                  tracksMissingMetaCount={session.tracks.filter(
                    (t) => !previewGenre(t.rel_path),
                  ).length}
                  favoriteCount={albumFavCount}
                  albumExcluded={albumExcluded}
                  tracksExcludedCount={albumExcluded
                    ? session.selectedAlbum.track_count
                    : session.tracks.filter((t) =>
                        player.getExcludedRelPaths().has(t.rel_path),
                      ).length}
                  loose={session.selectedAlbum.loose}
                />
              </div>
            </div>
            <div class="section-head__tools">
              <div class="hero-card__actions">
                <Button onclick={() => session.playAll(session.tracks)}>Riproduci album</Button>
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
          {#if albumGenre}
            <span class="album-hero__genre-chip" role="listitem">{albumGenre}</span>
          {/if}
          <button type="button" class="album-hero__genre-add" disabled title="In arrivo">
            +
          </button>
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
          <UiIcon name="queueMusic" class="album-tracklist-expected__ic" aria-hidden="true" />
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
      onplay={(track, list) => session.playTrack(track, list)}
      ontoggleFavorite={(track) => void session.toggleFavorite(track)}
      onaddToPlaylist={(playlistId, track) =>
        void session.addToPlaylist(playlistId, track.id)}
    />
  </section>
{:else if session.libraryLevel === "search"}
  {@const q = session.query.trim()}
  {@const hitArtists = session.matchArtists(q)}
  {@const hitAlbums = session.matchAlbums(q)}

  <div class="search-hero rk-surface-card">
    <div class="search-bar">
      <p class="rk-eyebrow">Ricerca</p>
      <strong class="search-title">Trova in libreria</strong>
      <div class="search-field">
        <TextInput
          type="search"
          bind:value={session.query}
          placeholder="Artista, album, brano…"
          oninput={onSearchInput}
          onkeydown={(e) => e.key === "Enter" && void session.searchLibrary()}
        />
        <Button
          variant="ghost"
          onclick={() => void session.backLibrary()}
          aria-label="Chiudi ricerca"
        >
          ✕
        </Button>
      </div>
    </div>
  </div>

  <section class="rk-surface-card library-page-body library-search-results">
    {#if !q}
      <p class="search-hint">Digita sopra oppure usa Ctrl+K dalla TopBar.</p>
    {:else}
      <section class="search-block">
        <SectionHeader title="Artisti" subtitle={`${hitArtists.length} risultati`} />
        <MediaGrid
          items={hitArtists.map((a) => ({
            id: a.id,
            title: a.name,
            subtitle: `${a.album_count} album · ${a.track_count} brani`,
            coverSrc: artistCoverById.has(a.id)
              ? albumCoverUrl(artistCoverById.get(a.id)!)
              : "",
            coverSeed: a.name,
          }))}
          emptyMessage="Nessun artista"
          onselect={(id) => void selectArtist(id)}
        />
      </section>
      <section class="search-block">
        <SectionHeader title="Album" subtitle={`${hitAlbums.length} risultati`} />
        <MediaGrid
          items={hitAlbums.map((a) => ({
            id: a.id,
            title: a.name,
            subtitle: a.artist_name,
            coverSrc: a.has_cover ? albumCoverUrl(a.id) : "",
            coverSeed: `${a.artist_name}/${a.name}`,
          }))}
          emptyMessage="Nessun album"
          onselect={(id) => void selectAlbum(id)}
        />
      </section>
      <section class="search-block">
        <SectionHeader title="Brani" subtitle={`${session.tracks.length} risultati`} />
        <TrackList
          tracks={session.tracks}
          favoriteIds={session.favoriteIds}
          playlistOptions={session.playlistOptions}
          activeTrackId={session.current?.id ?? null}
          emptyMessage="Nessun brano trovato"
          onplay={(track, list) => session.playTrack(track, list)}
          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
          onaddToPlaylist={(playlistId, track) =>
            void session.addToPlaylist(playlistId, track.id)}
        />
      </section>
    {/if}
  </section>
{/if}

<style>
  .lib-chrome {
    margin-bottom: 0;
    padding: var(--rk-space-3) var(--rk-space-4);
  }

  .library-page-body {
    min-width: 0;
    padding: var(--rk-space-3) var(--rk-space-4);
  }

  .library-page-body .library-filter-panel {
    margin-bottom: 0.85rem;
  }

  .count-line {
    margin: 0;
    color: color-mix(in srgb, var(--rk-accent-2) 45%, var(--rk-muted) 55%);
    font-size: 0.82rem;
    font-weight: 550;
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
    font-size: 0.75rem;
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
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .mood-pick-hint {
    margin: 0.15rem 0 0;
    color: var(--rk-muted);
    font-size: 0.86rem;
    line-height: 1.45;
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
    font-size: 1.05rem;
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
    margin: 0 0 var(--rk-space-3);
  }

  .album-tracklist-expected {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    margin-left: auto;
    padding-top: 0.15rem;
    font-size: 0.92rem;
    line-height: 1.35;
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

  .back {
    justify-self: start;
    border: 0;
    background: transparent;
    color: var(--rk-muted-strong);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.2rem 0;
    margin-bottom: 0.25rem;
  }

  .back:hover {
    color: var(--rk-ink);
  }

  .search-hero {
    margin-bottom: 0;
    padding: 0.85rem 1rem 0.95rem;
  }

  .library-search-results {
    min-width: 0;
  }

  .search-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem 0.9rem;
  }

  .search-title {
    flex: 1 1 10rem;
    min-width: 0;
    font-size: 0.95rem;
    font-weight: 750;
    letter-spacing: -0.02em;
  }

  .search-field {
    display: flex;
    flex: 0 1 24rem;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    margin-left: auto;
  }

  .search-hint {
    color: var(--rk-muted);
    margin: 0.25rem 0 0;
  }

  .search-block {
    margin-bottom: 0.85rem;
  }

  .search-block:last-child {
    margin-bottom: 0;
  }

  @media (max-width: 720px) {
    .search-field {
      flex: 1 1 100%;
      margin-left: 0;
    }
  }
</style>
