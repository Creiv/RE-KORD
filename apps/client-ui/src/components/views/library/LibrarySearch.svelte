<script lang="ts">
  /**
   * Library › search results. The matching is the session's (title, artist,
   * album, genres — never paths); this only lays results out: kind filter with
   * counts, sections without hits collapsed in the "all" view, artist / album
   * / track icons that match their kind, covers only when the hub has one.
   */
  import { EmptyState, SectionHeader, Segmented, TextInput } from "@rekord/ui";
  import MediaGrid from "../../MediaGrid.svelte";
  import PageToolbar from "../../PageToolbar.svelte";
  import TrackList from "../../TrackList.svelte";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { api, coverUrlFor } from "../../../lib/api";
  import { buildArtistCoverAlbumMap } from "../../../lib/artistCover";
  import { t, tp } from "../../../lib/i18n.svelte";
  import { session } from "../../../lib/session.svelte";
  import { toasts } from "../../../lib/toasts.svelte";

  type SearchFilter = "all" | "artists" | "albums" | "tracks";
  /** Rows per kind when all kinds share the page… */
  const MIXED_CAP = 12;
  /** …and when one kind has the page to itself. */
  const FOCUS_CAP = 60;

  let filter = $state<SearchFilter>("all");
  let wasOpen = false;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    // Each visit starts from the whole picture; refining the query keeps the kind.
    const open = session.libraryLevel === "search";
    if (open && !wasOpen) {
      filter = "all";
      // The field lives here: whoever opened the page (topbar, Ctrl+K, `/`) cannot focus it.
      queueMicrotask(() => document.getElementById("library-search-input")?.focus());
    }
    wasOpen = open;
  });

  const q = $derived(session.query.trim());
  const hitArtists = $derived(session.matchArtists(q));
  const hitAlbums = $derived(session.matchAlbums(q));
  const hitTracks = $derived(session.tracks);
  const total = $derived(hitArtists.length + hitAlbums.length + hitTracks.length);

  const artistCoverById = $derived(buildArtistCoverAlbumMap(session.artists, session.allAlbums));
  const albumById = $derived(new Map(session.allAlbums.map((a) => [a.id, a])));

  const showArtists = $derived(filter === "artists" || (filter === "all" && hitArtists.length > 0));
  const showAlbums = $derived(filter === "albums" || (filter === "all" && hitAlbums.length > 0));
  const showTracks = $derived(filter === "tracks" || (filter === "all" && hitTracks.length > 0));

  const filterOptions = $derived([
    { value: "all", label: t("search.filterAll") },
    { value: "artists", label: `${t("search.filterArtists")} ${hitArtists.length}`, disabled: hitArtists.length === 0 && filter !== "artists" },
    { value: "albums", label: `${t("search.filterAlbums")} ${hitAlbums.length}`, disabled: hitAlbums.length === 0 && filter !== "albums" },
    { value: "tracks", label: `${t("search.filterTracks")} ${hitTracks.length}`, disabled: hitTracks.length === 0 && filter !== "tracks" },
  ]);

  const FILTER_ICON = { all: "search", artists: "person", albums: "album", tracks: "note" } as const;

  function onInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void session.searchLibrary(), 200);
  }

  async function selectArtist(id: number | string) {
    try {
      await session.openArtist(await api.artist(Number(id)));
    } catch (e) {
      toasts.fail(e);
    }
  }

  async function selectAlbum(id: number | string) {
    try {
      await session.openAlbum(await api.album(Number(id)));
    } catch (e) {
      toasts.fail(e);
    }
  }
</script>

<PageToolbar
  eyebrow={t("search.eyebrow")}
  title={q ? tp("search.resultsTitle", total) : t("search.heading")}
  back={{ label: t("search.close"), onclick: () => void session.backLibrary() }}
>
  {#snippet tools()}
    <div class="search-field">
      <TextInput
        id="library-search-input"
        type="search"
        bind:value={session.query}
        placeholder={t("search.placeholder")}
        oninput={onInput}
        onkeydown={(e) => e.key === "Enter" && void session.searchLibrary()}
      />
    </div>
  {/snippet}
</PageToolbar>

<section class="rk-surface-card library-page-body library-search-results">
  {#if !q}
    <EmptyState variant="inline" title={t("search.heading")} body={t("search.hint")}>
      {#snippet icon()}<UiIcon name="search" />{/snippet}
    </EmptyState>
  {:else if total === 0}
    <EmptyState variant="inline" title={t("search.noResultsTitle")} body={t("search.emptyAll", { query: q })}>
      {#snippet icon()}<UiIcon name="search" />{/snippet}
    </EmptyState>
  {:else}
    <div class="search-filter-row">
      <Segmented
        ariaLabel={t("search.filterAria")}
        value={filter}
        onchange={(v) => (filter = v as SearchFilter)}
        options={filterOptions}
      >
        {#snippet icon(opt)}<UiIcon name={FILTER_ICON[opt.value as SearchFilter]} />{/snippet}
      </Segmented>
    </div>

    {#if showArtists}
      <section class="search-block">
        <SectionHeader title={t("search.filterArtists")} subtitle={tp("search.results", hitArtists.length)} />
        <MediaGrid
          kind="artist"
          items={hitArtists.slice(0, filter === "artists" ? FOCUS_CAP : MIXED_CAP).map((a) => {
            const coverAlbum = artistCoverById.get(a.id);
            const album = coverAlbum != null ? albumById.get(coverAlbum) : null;
            return {
              id: a.id,
              kind: "artist" as const,
              title: a.name,
              subtitle: t("library.artistSubtitle", {
                albums: tp("library.albumsCount", a.album_count),
                tracks: tp("library.tracksCount", a.track_count),
              }),
              coverSrc: album ? coverUrlFor(album, 256) : null,
              coverSeed: a.name,
            };
          })}
          emptyMessage={t("search.emptyArtists")}
          onselect={(id) => void selectArtist(id)}
        />
      </section>
    {/if}
    {#if showAlbums}
      <section class="search-block">
        <SectionHeader title={t("search.filterAlbums")} subtitle={tp("search.results", hitAlbums.length)} />
        <MediaGrid
          kind="album"
          items={hitAlbums.slice(0, filter === "albums" ? FOCUS_CAP : MIXED_CAP).map((a) => ({
            id: a.id,
            kind: "album" as const,
            title: a.name,
            subtitle: a.artist_name,
            coverSrc: coverUrlFor(a, 256),
            coverSeed: `${a.artist_name}/${a.name}`,
            loose: a.loose,
          }))}
          emptyMessage={t("search.emptyAlbums")}
          onselect={(id) => void selectAlbum(id)}
        />
      </section>
    {/if}
    {#if showTracks}
      <section class="search-block">
        <SectionHeader title={t("search.filterTracks")} subtitle={tp("search.results", hitTracks.length)} />
        <TrackList
          tracks={filter === "tracks" ? hitTracks : hitTracks.slice(0, 50)}
          favoriteIds={session.favoriteIds}
          playlistOptions={session.playlistOptions}
          activeTrackId={session.current?.id ?? null}
          emptyMessage={t("search.emptyTracks")}
          onplay={(track) => void session.playGlobalRadio(track)}
          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
          onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
        />
        {#if filter === "all" && hitTracks.length > 50}
          <button type="button" class="text-btn search-more" onclick={() => (filter = "tracks")}>
            {t("search.showAllTracks", { n: hitTracks.length })}
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  .library-search-results {
    min-width: 0;
    padding: var(--rk-space-md) var(--rk-space-lg);
  }

  .search-field {
    display: flex;
    flex: 0 1 22rem;
    align-items: center;
    min-width: 0;
  }

  .search-filter-row {
    display: flex;
    margin-bottom: 0.85rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .search-block {
    margin-bottom: 1.1rem;
  }

  .search-block:last-child {
    margin-bottom: 0;
  }

  .search-more {
    margin-top: 0.5rem;
  }

  @media (max-width: 719.98px) {
    .search-field {
      flex: 1 1 100%;
    }
  }

  @media (max-width: 999.98px) {
    .search-filter-row {
      margin-bottom: var(--rk-space-md);
    }

    /* The row scrolls sideways instead of squeezing the options to "T…",
       "Arti…": each keeps its full label. */
    .search-filter-row :global(.rk-seg) {
      flex: 0 0 auto;
      max-width: none;
    }

    .search-block {
      margin-bottom: var(--rk-space-lg);
    }
  }
</style>
