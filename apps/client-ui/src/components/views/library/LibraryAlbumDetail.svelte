<script lang="ts">
  /**
   * Library › album page (legacy album hero): back to the artist first, then a
   * cover + title block (stacked and centred on phones), one primary
   * "Riproduci album" with its icon, secondary actions, genre chips with a
   * labelled "Aggiungi genere", and the tracklist (covers, as in legacy).
   */
  import { onMount } from "svelte";
  import { Button, CoverArt } from "@rekord/ui";
  import EntityInfoAction from "../../EntityInfoAction.svelte";
  import MetaBadgeCluster from "../../MetaBadgeCluster.svelte";
  import SectionHeadLead from "../../SectionHeadLead.svelte";
  import TrackList from "../../TrackList.svelte";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { api, coverUrlFor, type Album, type Track } from "../../../lib/api";
  import { floating } from "../../../lib/floatingPopover";
  import { confirmDialog } from "../../../lib/confirm.svelte";
  import {
    countGenreLabels,
    fieldHasGenreLabel,
    genreLabelChoices,
    genreLabelKey,
    parseTrackGenres,
    serializeTrackGenres,
    trackGenres,
  } from "../../../lib/genres";
  import { fmtDate, i18n, t, tp } from "../../../lib/i18n.svelte";
  import { player } from "../../../lib/player";
  import { prefsRevision } from "../../../lib/prefsRevision.svelte";
  import { session } from "../../../lib/session.svelte";
  import { GENRE_POOL, albumHasAlbumMeta, trackHasFileMeta } from "../../../lib/trackMoods";

  let { album }: { album: Album } = $props();

  let genrePickerOpen = $state(false);
  let genreBusy = $state(false);
  let genreErr = $state<string | null>(null);
  let genreAddWrapEl = $state<HTMLDivElement | null>(null);
  let genreMenuEl = $state<HTMLUListElement | null>(null);

  onMount(() => {
    const onDocPointer = (ev: MouseEvent) => {
      if (!genrePickerOpen) return;
      const target = ev.target;
      if (target instanceof Node && genreAddWrapEl?.contains(target)) return;
      // The menu lives on <body> (use:floating), outside the wrap.
      if (target instanceof Node && genreMenuEl?.contains(target)) return;
      genrePickerOpen = false;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") genrePickerOpen = false;
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  $effect(() => {
    void album.id;
    genrePickerOpen = false;
    genreErr = null;
  });

  const tracks = $derived(session.tracks);

  const exclusions = $derived.by(() => {
    void prefsRevision.exclusions;
    return {
      paths: new Set(player.getExcludedRelPaths()),
      albums: new Set(player.getExcludedAlbumIds()),
    };
  });
  const albumExcluded = $derived(exclusions.albums.has(album.id));
  const tracksExcludedCount = $derived(
    albumExcluded ? album.track_count : tracks.filter((tr) => exclusions.paths.has(tr.rel_path)).length,
  );
  const favCount = $derived(session.favorites.filter((tr) => tr.album_id === album.id).length);
  const tracksMissingMeta = $derived(tracks.filter((tr) => !trackHasFileMeta(tr)).length);

  /** Folder segments for entity info (folder_key = "artist/album…"). */
  const artistDir = $derived(album.folder_key.split("/")[0]?.trim() || album.artist_name);
  const albumDir = $derived.by(() => {
    const slash = album.folder_key.indexOf("/");
    const rest = slash >= 0 ? album.folder_key.slice(slash + 1).trim() : "";
    return rest || album.name;
  });

  /** Full release date when the hub has one ("15 nov 2024"), else the year. */
  const releaseLabel = $derived.by(() => {
    const raw = album.release_date?.trim() ?? "";
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return fmtDate(raw);
    const year = raw.match(/\d{4}/)?.[0];
    return year ?? null;
  });
  const label = $derived(album.label?.trim() || null);
  const totalMinutes = $derived(
    Math.round(tracks.reduce((sum, tr) => sum + (tr.duration_ms || 0), 0) / 60000),
  );
  const expected = $derived.by(() => {
    const n = album.expected_track_count;
    return n != null && n > 0 ? n : null;
  });

  /**
   * Genres present on the album's tracks, one chip per label → track count.
   * Keyed on the label (`genreLabelKey`), not the raw key: aliases such as
   * "Rhythm & Blues" and "R&B" are one chip, one picker entry, one edit.
   */
  const trackGenreStats = $derived(
    countGenreLabels(tracks.map((tr) => tr.genre)).sort((a, b) =>
      a.label.localeCompare(b.label, i18n.sortLocale, { numeric: true }),
    ),
  );

  /** Library genres (or the pool) not on the album yet — for the add picker. */
  const genreOptions = $derived(
    genreLabelChoices(
      session.catalogTracks.map((tr) => tr.genre),
      GENRE_POOL,
      new Set(trackGenreStats.map((g) => g.key)),
    ).sort((a, b) => a.label.localeCompare(b.label, i18n.sortLocale, { numeric: true })),
  );

  async function applyGenre(token: string, mode: "add" | "remove", target: Track[] = tracks) {
    const g = token.trim();
    if (!g || !target.length) return;
    const key = genreLabelKey(g);
    genreBusy = true;
    genreErr = null;
    try {
      for (const tr of target) {
        const cur = parseTrackGenres(tr.genre);
        const has = cur.some((x) => genreLabelKey(x) === key);
        if (mode === "add" ? has : !has) continue;
        const next = mode === "add" ? [...cur, g] : cur.filter((x) => genreLabelKey(x) !== key);
        const serialized = serializeTrackGenres(next);
        await api.trackInfoSave(tr.rel_path, { genre: serialized ?? "" });
        // Lists are immutable ($state.raw): replace the track everywhere it appears.
        session.patchTrack(tr.rel_path, { genre: serialized, genres: trackGenres({ genre: serialized }) });
      }
    } catch (e) {
      genreErr = e instanceof Error ? e.message : String(e);
    } finally {
      genreBusy = false;
    }
  }

  async function addGenre(g: string) {
    // Close first: while the saves run (one request per track, slow on a
    // phone) the list would shift under the finger and a second tap would
    // start a concurrent edit from stale genre lists.
    if (genreBusy) return;
    genrePickerOpen = false;
    await applyGenre(g, "add");
  }

  async function fillGenre(g: string) {
    const missing = tracks.filter((tr) => !fieldHasGenreLabel(tr.genre, g));
    if (!missing.length) return;
    const ok = await confirmDialog({ title: t("albumMeta.addGenreMissingConfirm", { g, n: missing.length }) });
    if (ok) await applyGenre(g, "add", missing);
  }

  async function removeGenre(g: string) {
    const ok = await confirmDialog({ title: t("albumMeta.removeGenreAllConfirm", { g }), danger: true });
    if (ok) await applyGenre(g, "remove");
  }
</script>

<div class="album-page">
  <section class="album-hero rk-surface-card album-detail">
    <button
      type="button"
      class="album-detail__cover"
      title={t("library.editCover")}
      aria-label={t("library.uploadCoverAria")}
      onclick={() => session.openCoverEdit()}
    >
      <CoverArt kind="album" class="album-detail__cover-art" title={album.name} src={coverUrlFor(album)} size="xl" loading="eager" />
      <span class="album-detail__cover-badge" aria-hidden="true"><UiIcon name="image" /></span>
    </button>

    <!-- Legacy album hero: back chevron + eyebrow + status chips on the left,
         the album actions on the right; the title and meta below. -->
    <div class="album-detail__toprow">
      <div class="page-toolbar__lead page-toolbar__lead--backrow album-detail__lead">
        <button
          type="button"
          class="page-toolbar-back-ic album-detail__back"
          title={`${t("library.backToArtistAria")}: ${album.artist_name}`}
          aria-label={`${t("library.backToArtistAria")}: ${album.artist_name}`}
          onclick={() => void session.backLibrary()}
        >
          <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
        </button>
        <div class="page-toolbar__textcol">
          <p class="rk-eyebrow">{album.loose ? t("library.looseAlbum") : t("library.albumDetail")}</p>
          <MetaBadgeCluster
            variant="hero"
            missingMeta={!albumHasAlbumMeta(album)}
            tracksMissingMetaCount={tracksMissingMeta}
            favoriteCount={favCount}
            {albumExcluded}
            {tracksExcludedCount}
            loose={album.loose}
          />
        </div>
      </div>

      <div class="album-detail__actions">
        <Button class="album-detail__play" disabled={!tracks.length} onclick={() => session.playSequence(tracks, 0)}>
          <UiIcon name="play" />
          {t("library.playAlbum")}
        </Button>
        <Button
          variant="ghost"
          disabled={!tracks.length}
          title={t("library.shuffleAlbum")}
          aria-label={t("library.shuffleAlbum")}
          onclick={() => session.playPoolShuffle(tracks)}
        >
          <UiIcon name="shuffle" />
        </Button>
        <EntityInfoAction {artistDir} albumDir={album.loose ? null : albumDir} loose={album.loose} title={album.name} />
        <Button variant="ghost" title={t("library.editAlbum")} aria-label={t("library.editAlbum")} onclick={() => session.openAlbumEdit()}>
          <UiIcon name="edit" />
        </Button>
        <Button
          variant="ghost"
          class={albumExcluded ? "album-detail__exclude is-on" : "album-detail__exclude"}
          aria-pressed={albumExcluded}
          title={t("library.shuffleBlock")}
          aria-label={t("library.shuffleBlock")}
          onclick={() => player.toggleExcludeAlbum(album.id)}
        >
          <UiIcon name="exclude" />
        </Button>
      </div>
    </div>

    <h1 class="album-detail__title">{album.name}</h1>

    <div class="album-detail__info">
      <p class="album-detail__meta">
        <button type="button" class="album-detail__artist" onclick={() => void session.backLibrary()}>
          {album.artist_name}
        </button>
        {#if releaseLabel}<span>{releaseLabel}</span>{/if}
        {#if label}<span>{label}</span>{/if}
        <span>{tp("library.tracksCount", tracks.length || album.track_count)}</span>
        {#if totalMinutes > 0}<span>{t("library.albumMinutes", { n: totalMinutes })}</span>{/if}
      </p>

      <div class="album-detail__genres" role="list" aria-label={t("library.albumGenresAria")}>
        {#each trackGenreStats as g (g.key)}
          <span class="album-hero__genre-chip" role="listitem">
            <button
              type="button"
              class="album-hero__genre-chip__text"
              disabled={genreBusy}
              title={t("albumMeta.applyGenreMissingTitle", { g: g.label, n: g.count, total: tracks.length })}
              onclick={() => void fillGenre(g.label)}
            >
              {g.label}
              {#if g.count < tracks.length}<span class="album-detail__genre-count">{g.count}/{tracks.length}</span>{/if}
            </button>
            <button
              type="button"
              class="album-hero__genre-chip__x"
              disabled={genreBusy}
              aria-label={t("trackMeta.fieldGenreRemoveAria", { g: g.label })}
              onclick={() => void removeGenre(g.label)}
            >
              <UiIcon name="close" class="album-hero__genre-chip__x-ic" />
            </button>
          </span>
        {/each}
        {#if genreOptions.length > 0}
          <div class="album-hero__genre-add-wrap" bind:this={genreAddWrapEl}>
            <button
              type="button"
              class="album-detail__genre-add"
              disabled={genreBusy}
              aria-expanded={genrePickerOpen}
              onclick={(e) => {
                e.stopPropagation();
                genrePickerOpen = !genrePickerOpen;
              }}
            >
              <UiIcon name="add" />
              <span>{t("trackMeta.fieldGenreAdd")}</span>
            </button>
            {#if genrePickerOpen}
              <ul
                bind:this={genreMenuEl}
                class="track-row__overflow-menu album-hero__genre-menu rk-scroll"
                role="menu"
                use:floating={{ anchor: genreAddWrapEl, placement: "bottom-start", minWidth: 200 }}
              >
                {#each genreOptions as opt (opt.key)}
                  <li role="presentation">
                    <button
                      type="button"
                      role="menuitem"
                      class="track-row__overflow-item"
                      disabled={genreBusy}
                      onclick={() => void addGenre(opt.label)}
                    >
                      <span class="track-row__overflow-item-glyph" aria-hidden="true"><UiIcon name="style" /></span>
                      <span class="track-row__overflow-item-label">{opt.label}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
        {#if genreErr}
          <p class="album-hero__genre-err" role="alert">{genreErr}</p>
        {/if}
      </div>
    </div>
  </section>

  <section class="album-hero__tracks rk-surface-card">
    <div class="album-detail__tracks-head">
      <SectionHeadLead eyebrow={t("library.tracklist")} title={tp("library.tracksCount", tracks.length)}>
        <UiIcon name="music" />
      </SectionHeadLead>
      {#if expected != null}
        <span class="album-detail__expected" title={t("library.expectedTracksTitle", { n: tracks.length, total: expected })}>
          <UiIcon name="queueMusic" />
          {tracks.length}/{expected}
        </span>
      {/if}
    </div>
    <TrackList
      {tracks}
      inAlbum
      favoriteIds={session.favoriteIds}
      playlistOptions={session.playlistOptions}
      activeTrackId={session.current?.id ?? null}
      onplay={(track, list) => {
        const idx = list.findIndex((x) => x.id === track.id);
        session.playSequence(list, idx >= 0 ? idx : 0);
      }}
      ontoggleFavorite={(track) => void session.toggleFavorite(track)}
      onaddToPlaylist={(playlistId, track) => void session.addToPlaylist(playlistId, track.id)}
    />
  </section>
</div>

<style>
  .album-page {
    display: grid;
    gap: var(--rk-section-gap, 1rem);
    min-width: 0;
  }

  /* Legacy album hero: cover spanning the left column; on the right a
     toolbar row (back chevron, eyebrow + chips | actions), the title, then
     the meta line and the genre chips. */
  .album-detail {
    display: grid;
    grid-template-columns: clamp(140px, 16vw, 200px) minmax(0, 1fr);
    grid-template-rows: auto auto 1fr;
    gap: 0.9rem 1.5rem;
    align-items: start;
    padding: var(--rk-space-lg, 1.25rem);
  }

  .album-detail__toprow {
    grid-column: 2;
    grid-row: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.6rem 1rem;
    min-width: 0;
  }

  .album-detail__lead {
    align-items: flex-start;
    min-width: 0;
  }

  .album-detail__lead :global(.page-toolbar-back-ic) {
    align-self: flex-start;
    margin-top: 0.08rem;
  }

  .album-detail__lead :global(.rk-eyebrow) {
    margin: 0;
  }

  .album-detail__cover {
    grid-column: 1;
    grid-row: 1 / -1;
    position: relative;
    padding: 0;
    border: none;
    background: none;
    border-radius: var(--rk-radius-cover, 12px);
    cursor: pointer;
    line-height: 0;
  }

  .album-detail__cover :global(.rk-cover.album-detail__cover-art) {
    width: clamp(140px, 16vw, 200px);
    height: clamp(140px, 16vw, 200px);
    --cover-initials: 3rem;
  }

  .album-detail__cover-badge {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    /* Legacy: rounded square, not a dot. */
    border-radius: 10px;
    background: color-mix(in srgb, var(--rk-surface) 78%, transparent);
    border: 1px solid var(--rk-line);
    color: var(--rk-ink);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .album-detail__cover:hover .album-detail__cover-badge,
  .album-detail__cover:focus-visible .album-detail__cover-badge {
    opacity: 1;
  }

  .album-detail__cover-badge :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  .album-detail__info {
    grid-column: 2;
    grid-row: 3;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
    align-content: start;
  }

  .album-detail__title {
    grid-column: 2;
    grid-row: 2;
    margin: 0;
    font-size: clamp(1.5rem, 3vw, 2rem);
    line-height: 1.15;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .album-detail__meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
  }

  .album-detail__meta > :not(:first-child)::before {
    content: "·";
    margin: 0 0.45rem;
    color: var(--rk-muted);
  }

  .album-detail__artist {
    padding: 0;
    border: none;
    background: none;
    color: var(--rk-ink);
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }

  .album-detail__artist:hover {
    text-decoration: underline;
  }

  .album-detail__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .album-detail__actions :global(.album-detail__exclude.is-on) {
    color: var(--rk-accent-2);
    border-color: color-mix(in srgb, var(--rk-accent-2) 45%, var(--rk-line));
  }

  .album-detail__actions :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }

  .album-detail__genres {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .album-detail__genre-count {
    margin-left: 0.3rem;
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    font-variant-numeric: tabular-nums;
  }

  .album-detail__genre-add {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.9rem;
    padding: 0.2rem 0.7rem 0.2rem 0.5rem;
    border-radius: 999px;
    border: 1px dashed var(--rk-line-strong, var(--rk-line));
    background: transparent;
    color: var(--rk-muted-strong, var(--rk-muted));
    font: inherit;
    font-size: var(--rk-fs-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .album-detail__genre-add :global(svg) {
    width: 0.95rem;
    height: 0.95rem;
  }

  .album-detail__genre-add:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .album-detail__genre-add:hover:not(:disabled) {
    color: var(--rk-ink);
    border-color: var(--rk-accent);
  }

  .album-detail__tracks-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.65rem 1.25rem;
    margin: 0 0 var(--rk-space-md, 0.85rem);
  }

  .album-detail__expected {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--rk-muted);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .album-detail__expected :global(svg) {
    width: 18px;
    height: 18px;
  }

  /* Phones (legacy responsive album hero): cover on the left with the back
     row and the actions beside it, title, meta and genres full width below.
     The old stacked layout (240px cover centred, everything under it) spent
     most of the first screen before the first track. */
  @media (max-width: 719.98px) {
    .album-detail {
      grid-template-columns: clamp(108px, 32vw, 152px) minmax(0, 1fr);
      grid-template-rows: none;
      grid-template-areas:
        "cover top"
        "title title"
        "info info";
      gap: var(--rk-space-md) var(--rk-space-lg);
      padding: var(--rk-space-lg);
    }

    .album-detail__cover {
      grid-area: cover;
    }

    .album-detail__toprow {
      grid-area: top;
      flex-direction: column;
      flex-wrap: nowrap;
      align-items: stretch;
      justify-content: flex-start;
      gap: var(--rk-space-sm);
    }

    .album-detail__title {
      grid-area: title;
      font-size: var(--rk-fs-6);
    }

    .album-detail__info {
      grid-area: info;
      gap: var(--rk-space-sm);
    }

    .album-detail__cover :global(.rk-cover.album-detail__cover-art) {
      width: clamp(108px, 32vw, 152px);
      height: clamp(108px, 32vw, 152px);
    }

    .album-detail__actions {
      justify-content: flex-start;
      gap: var(--rk-space-xs);
    }

    .album-detail__actions :global(.album-detail__play) {
      flex: 1 1 100%;
      justify-content: center;
    }

    .album-detail__tracks-head {
      margin-bottom: var(--rk-space-sm);
    }
  }
</style>
