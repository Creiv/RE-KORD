<script lang="ts">
  import { CoverArt } from "@rekord/ui";
  import {
    api,
    artistCoverUrl,
    type CatalogArtistEntry,
    type CatalogWebItem,
    type LibrarySelectionV1,
    coverUrlFor,
  } from "../../lib/api";
  import {
    catalogArtistNeedsAttention,
    indexHasAlbum,
    indexHasArtist,
    selectionHasAlbum,
    selectionHasArtist,
  } from "../../lib/catalogHelpers";
  import { catalogDiscover, type DiscoverResult } from "../../lib/api/studio";
  import { i18n, t, tp } from "../../lib/i18n.svelte";
  import { studioCodeText, studioErrorText } from "../../lib/studio/errors";
  import { session } from "../../lib/session.svelte";
  import { downloadFlow } from "../../lib/studio/downloadFlow.svelte";
  import { studioDownloads } from "../../lib/studio/downloadStore.svelte";
  import { studioLibraryHit } from "../../lib/studio/libraryIndex.svelte";
  import type { LibraryHit } from "../../lib/studio/libraryMatch";
  import UiIcon from "../icons/UiIcon.svelte";
  import StudioCatalogPreviewDialog from "./StudioCatalogPreviewDialog.svelte";
  import StudioModeSwitch from "./StudioModeSwitch.svelte";

  let {
    onSendToDownload,
  }: {
    onSendToDownload: (item: CatalogWebItem, mode: "single" | "playlist", library: LibraryHit | null) => void;
  } = $props();

  let catalogMode = $state<"local" | "web">("local");
  let catalogQuery = $state("");
  let catalogOnlyAttention = $state(true);
  let catalogArtistDetail = $state<CatalogArtistEntry | null>(null);
  let catalogArtistsData = $state<CatalogArtistEntry[]>([]);
  let mySelection = $state<LibrarySelectionV1 | null>(null);
  let catalogBusy = $state(false);
  let catalogErr = $state<string | null>(null);
  let catalogMsg = $state<string | null>(null);
  let catalogLoaded = $state(false);

  let webDiscover = $state<DiscoverResult | null>(null);
  /** Locale the web list was fetched for: switching language refetches. */
  let webLocale = "";
  let webBusy = $state(false);
  let webErr = $state<string | null>(null);
  let previewItem = $state<CatalogWebItem | null>(null);

  const catalogArtists = $derived.by(() => {
    const q = catalogQuery.trim().toLowerCase();
    return catalogArtistsData.filter((ar) => {
      if (q && !ar.name.toLowerCase().includes(q)) return false;
      if (
        catalogOnlyAttention &&
        !catalogArtistNeedsAttention(ar, session.allAlbums, mySelection)
      ) {
        return false;
      }
      return true;
    });
  });

  const selectionIncludeAll = $derived(Boolean(mySelection?.includeAll));

  async function loadCatalogPane(force = false) {
    if (!force && catalogLoaded && catalogArtistsData.length && mySelection) return;
    catalogBusy = true;
    catalogErr = null;
    catalogArtistDetail = null;
    try {
      const [cat, sel] = await Promise.all([
        api.catalog({ summary: true }),
        api.myLibrarySelection(),
      ]);
      catalogArtistsData = cat.artists;
      mySelection = sel;
      catalogLoaded = true;
    } catch (e) {
      catalogErr = studioErrorText(e);
      catalogArtistsData = [];
      mySelection = null;
    } finally {
      catalogBusy = false;
    }
  }

  async function openCatalogArtist(artistId: string) {
    catalogBusy = true;
    catalogErr = null;
    try {
      const cat = await api.catalog({ artistId });
      catalogArtistDetail =
        cat.artists.find((a) => a.id === artistId) ??
        catalogArtistsData.find((a) => a.id === artistId) ??
        cat.artists[0] ??
        null;
    } catch (e) {
      catalogErr = studioErrorText(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function afterCatalogPatch() {
    catalogMsg = t("studio.catalog.updated");
    try {
      if (catalogArtistDetail) {
        const [cat, sel] = await Promise.all([
          api.catalog({ artistId: catalogArtistDetail.id }),
          api.myLibrarySelection(),
        ]);
        catalogArtistDetail = cat.artists[0] ?? null;
        mySelection = sel;
      } else {
        await loadCatalogPane(true);
      }
      await Promise.all([session.loadArtists(), session.loadAllAlbums()]);
    } catch {
      /* ignore */
    }
  }

  async function addArtistCatalog(artistId: string) {
    catalogBusy = true;
    catalogErr = null;
    try {
      mySelection = await api.patchMyLibrarySelection({ addArtists: [artistId] });
      await afterCatalogPatch();
    } catch (e) {
      catalogErr = studioErrorText(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function removeArtistCatalog(artistId: string) {
    catalogBusy = true;
    catalogErr = null;
    try {
      mySelection = await api.patchMyLibrarySelection({
        includeAll: false,
        removeArtists: [artistId],
      });
      await afterCatalogPatch();
    } catch (e) {
      catalogErr = studioErrorText(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function addAlbumCatalog(folderKey: string) {
    catalogBusy = true;
    catalogErr = null;
    try {
      mySelection = await api.patchMyLibrarySelection({ addAlbums: [folderKey] });
      await afterCatalogPatch();
    } catch (e) {
      catalogErr = studioErrorText(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function removeAlbumCatalog(folderKey: string) {
    catalogBusy = true;
    catalogErr = null;
    try {
      mySelection = await api.patchMyLibrarySelection({ removeAlbums: [folderKey] });
      await afterCatalogPatch();
    } catch (e) {
      catalogErr = studioErrorText(e);
    } finally {
      catalogBusy = false;
    }
  }

  const SINGLE_RE = /^(single|singolo|video)\b/i;

  /** Singles that the hub left in the albums feed (subtitle "Singolo • …"). */
  function splitSingles(r: DiscoverResult): DiscoverResult {
    const albums: DiscoverResult["albums"] = [];
    const songs = r.songs.slice();
    const seen = new Set(songs.map((s) => s.url));
    for (const it of r.albums) {
      const kind = (it.kind ?? "").toLowerCase();
      const single = kind === "single" || kind === "song" || (!kind && SINGLE_RE.test(it.subtitle.trim()));
      if (single) {
        if (!seen.has(it.url)) songs.push(it);
        seen.add(it.url);
      } else {
        albums.push(it);
      }
    }
    return { ...r, albums, songs };
  }

  async function loadWebDiscover(force = false) {
    webBusy = true;
    webErr = null;
    webLocale = i18n.locale;
    try {
      webDiscover = splitSingles(await catalogDiscover(force, i18n.locale));
    } catch (e) {
      webErr = studioErrorText(e);
      webDiscover = { albums: [], songs: [], error: null, singlesRecovered: false };
    } finally {
      webBusy = false;
    }
  }

  /** Tiles already in the library (badge + warning in the download confirm). */
  const webHits = $derived.by(() => {
    const out: Record<string, LibraryHit> = {};
    const scan = (items: CatalogWebItem[], kind: "album" | "song") => {
      for (const it of items) {
        const hit = studioLibraryHit({ kind, title: it.title, subtitle: it.subtitle });
        if (hit) out[it.url] = hit;
      }
    };
    scan(webDiscover?.albums ?? [], "album");
    scan(webDiscover?.songs ?? [], "song");
    return out;
  });
  const dlLocked = $derived(studioDownloads.busy || downloadFlow.open || !!downloadFlow.pendingUrl);

  const webHubError = $derived(
    webDiscover?.error ? studioCodeText(webDiscover.error.code, webDiscover.error.message) : null,
  );

  $effect(() => {
    if (catalogMode === "local") void loadCatalogPane();
    else if (!webDiscover || webLocale !== i18n.locale) void loadWebDiscover();
  });
</script>

{#snippet webColumn(title: string, items: CatalogWebItem[], mode: "single" | "playlist")}
  <section class="studio-panel studio-catalog-web-col" aria-label={title}>
    <h4 class="studio-panel-title">
      {title}
      <span class="studio-catalog-web-col__count">{items.length}</span>
    </h4>
    {#if webBusy && !webDiscover}
      <ul class="studio-catalog-web-list" aria-busy="true" aria-label={t("studio.catalog.loading")}>
        {#each Array(5) as _, i (i)}
          <li class="studio-catalog-web-tile studio-skeleton-row" aria-hidden="true">
            <span class="studio-skeleton studio-skeleton--thumb-lg"></span>
            <span class="studio-skeleton-row__text">
              <span class="studio-skeleton studio-skeleton--line"></span>
              <span class="studio-skeleton studio-skeleton--line studio-skeleton--short"></span>
            </span>
          </li>
        {/each}
      </ul>
    {:else if items.length}
      <ul class="studio-catalog-web-list">
        {#each items as item, i (`${item.url}:${i}`)}
          <li class="studio-catalog-web-tile">
            <button
              type="button"
              class="studio-catalog-web-tile__main"
              title={t("studio.catalog.previewTitle")}
              onclick={() => (previewItem = item)}
            >
              <span class="studio-catalog-web-tile__art">
                {#if item.thumbnailUrl}
                  <img src={item.thumbnailUrl} alt="" width="56" height="56" loading="lazy" />
                {:else}
                  <UiIcon name="album" />
                {/if}
                <span class="studio-catalog-web-tile__play" aria-hidden="true"><UiIcon name="play" /></span>
              </span>
              <span class="studio-catalog-web-tile__text">
                <span class="studio-catalog-web-tile__title">{item.title}</span>
                <span class="studio-catalog-web-tile__meta">{item.subtitle}</span>
                {#if webHits[item.url]}
                  <span class="studio-inlib-badge" title={t("studio.dl.inLibraryTitle")}>
                    <UiIcon name="check" />{t("studio.dl.inLibrary")}
                  </span>
                {/if}
              </span>
            </button>
            <button
              type="button"
              class="ghost-btn ghost-btn--sm studio-catalog-web-tile__dl studio-busy-btn"
              title={t("studio.catalog.download")}
              disabled={dlLocked}
              aria-busy={downloadFlow.pendingUrl === item.url}
              onclick={() => onSendToDownload(item, mode, webHits[item.url] ?? null)}
            >
              {#if downloadFlow.pendingUrl === item.url}
                <span class="studio-spinner studio-spinner--sm" aria-hidden="true"></span>
              {:else}
                <UiIcon name="download" />
              {/if}
              <span>{t("studio.catalog.download")}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="panel-empty">{webBusy ? t("studio.catalog.loading") : t("studio.catalog.webEmpty")}</p>
    {/if}
  </section>
{/snippet}

<div class="studio-pane studio-catalog-pane" role="region" aria-label={t("studio.catalog.regionAria")}>
  <div class="studio-catalog-browse">
    <div class="studio-catalog-head">
      <p class="subtle sm studio-catalog-browse-lead">
        {catalogMode === "web"
          ? t("studio.catalog.leadWeb")
          : t("studio.catalog.leadLocal")}
      </p>
      <StudioModeSwitch
        class="studio-catalog-head__mode-switch"
        label={t("studio.catalog.modeAria")}
        left={t("studio.catalog.modeLocal")}
        right={t("studio.catalog.modeWeb")}
        rightActive={catalogMode === "web"}
        onchange={(web) => {
          catalogMode = web ? "web" : "local";
          if (web) catalogArtistDetail = null;
        }}
      />
    </div>

    {#if catalogMode === "web"}
      <div class="studio-catalog-toolbar">
        <div class="studio-catalog-toolbar__row">
          <button
            type="button"
            class="primary-btn primary-btn--sm studio-busy-btn"
            disabled={webBusy}
            aria-busy={webBusy}
            onclick={() => void loadWebDiscover(true)}
          >
            {#if webBusy}
              <span class="studio-spinner studio-spinner--sm" aria-hidden="true"></span>
            {/if}
            {webBusy ? t("studio.catalog.refreshing") : t("studio.catalog.refreshNew")}
          </button>
        </div>
      </div>
      {#if webErr}
        <p class="subtle sm warnline" role="alert">{webErr}</p>
      {:else if webHubError}
        <p class="subtle sm warnline" role="note">{t("studio.catalog.webPartial", { error: webHubError })}</p>
      {/if}
      <div class="studio-catalog-web-cols">
        {@render webColumn(t("studio.catalog.albumsEps"), webDiscover?.albums ?? [], "playlist")}
        {@render webColumn(t("studio.catalog.singles"), webDiscover?.songs ?? [], "single")}
      </div>
    {:else}
      <div class="studio-catalog-toolbar">
        <div class="studio-catalog-toolbar__row">
          <button
            type="button"
            class="primary-btn primary-btn--sm studio-busy-btn"
            disabled={catalogBusy}
            aria-busy={catalogBusy}
            onclick={() => void loadCatalogPane(true)}
          >
            {#if catalogBusy}
              <span class="studio-spinner studio-spinner--sm" aria-hidden="true"></span>
            {/if}
            {catalogBusy ? t("studio.catalog.refreshing") : t("studio.catalog.refreshList")}
          </button>
          {#if !catalogArtistDetail}
            <input
              type="search"
              class="ghost-input ghost-input--search studio-catalog-toolbar__search"
              placeholder={t("studio.catalog.searchPh")}
              aria-label={t("studio.catalog.searchAria")}
              bind:value={catalogQuery}
            />
          {/if}
        </div>
        {#if !catalogArtistDetail}
          <label class="studio-catalog-toolbar__check">
            <input type="checkbox" bind:checked={catalogOnlyAttention} />
            <span>{t("studio.catalog.filterAttention")}</span>
          </label>
        {/if}
        {#if selectionIncludeAll}
          <p class="subtle sm">
            {t("studio.catalog.includeAll")}
            <button
              type="button"
              class="ghost-btn"
              disabled={catalogBusy}
              onclick={async () => {
                catalogBusy = true;
                try {
                  mySelection = await api.patchMyLibrarySelection({ includeAll: false });
                  await afterCatalogPatch();
                } catch (e) {
                  catalogErr = studioErrorText(e);
                } finally {
                  catalogBusy = false;
                }
              }}
            >
              {t("studio.catalog.useManual")}
            </button>
          </p>
        {/if}
      </div>

      {#if catalogArtistDetail}
        <div class="section-head section-head--page-toolbar">
          <div class="page-toolbar__lead page-toolbar__lead--backrow">
            <button
              type="button"
              class="page-toolbar-back-ic"
              aria-label={t("studio.catalog.backArtists")}
              onclick={() => (catalogArtistDetail = null)}
            >
              <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
            </button>
            <div class="page-toolbar__textcol">
              <p class="rk-eyebrow">{t("studio.catalog.albumEyebrow")}</p>
              <h2>{catalogArtistDetail.name}</h2>
            </div>
          </div>
        </div>
        <div class="library-overview-cols">
          {#each catalogArtistDetail.rel_albums as al, i (`${al.folder_key}:${i}`)}
            {@const inIndex = indexHasAlbum(session.allAlbums, al.folder_key)}
            {@const sel = selectionHasAlbum(mySelection, al.folder_key, catalogArtistDetail.id)}
            <div
              class="studio-catalog-list-tile"
              class:studio-catalog-list-tile--selected={sel}
              class:studio-catalog-list-tile--dim={!inIndex && !sel}
            >
              <div class="studio-catalog-list-tile__main">
                <CoverArt
                  title={al.name}
                  seed={`${al.artist}/${al.name}`}
                  src={coverUrlFor(al, 128)}
                  size="tile"
                />
                <div>
                  <div class="library-list-tile__title-row">
                    <UiIcon name="album" class="library-list-tile__kind-ic" />
                    <div class="library-list-tile__title">{al.name}</div>
                  </div>
                  <div class="library-list-tile__meta">{tp("library.tracksCount", al.track_count)}</div>
                </div>
              </div>
              <div class="studio-catalog-list-tile__actions">
                {#if sel}
                  <button
                    type="button"
                    class="ghost-btn danger"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void removeAlbumCatalog(al.folder_key)}
                  >
                    {t("studio.catalog.removeLibrary")}
                  </button>
                {:else}
                  <button
                    type="button"
                    class="primary-btn"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void addAlbumCatalog(al.folder_key)}
                  >
                    {t("studio.catalog.addLibrary")}
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <p class="studio-catalog-filter-empty">{t("studio.catalog.noAlbums")}</p>
          {/each}
        </div>
      {:else}
        <div class="library-overview-cols">
          {#each catalogArtists as artist (artist.id)}
            {@const inIndex = indexHasArtist(session.artists, artist.id)}
            {@const sel = selectionHasArtist(mySelection, artist.id)}
            {@const coverId = artist.db_id}
            <div
              class="studio-catalog-list-tile"
              class:studio-catalog-list-tile--selected={sel}
              class:studio-catalog-list-tile--dim={!inIndex && !sel}
            >
              <button
                type="button"
                class="studio-catalog-list-tile__main"
                onclick={() => void openCatalogArtist(artist.id)}
              >
                <CoverArt
                  title={artist.name}
                  seed={artist.name}
                  src={artist.has_cover && coverId ? artistCoverUrl(coverId, 128) : ""}
                  size="tile"
                />
                <div>
                  <div class="library-list-tile__title-row">
                    <UiIcon name="person" class="library-list-tile__kind-ic" />
                    <div class="library-list-tile__title">{artist.name}</div>
                  </div>
                  <div class="library-list-tile__meta">
                    {tp("library.albumsCount", artist.album_count)} · {tp("library.tracksCount", artist.track_count)}
                  </div>
                </div>
              </button>
              <div class="studio-catalog-list-tile__actions">
                {#if sel}
                  <button
                    type="button"
                    class="ghost-btn danger"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void removeArtistCatalog(artist.id)}
                  >
                    {t("studio.catalog.removeLibrary")}
                  </button>
                {:else}
                  <button
                    type="button"
                    class="primary-btn"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void addArtistCatalog(artist.id)}
                  >
                    {t("studio.catalog.addLibrary")}
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <p class="studio-catalog-filter-empty" class:studio-loading-line={catalogBusy} role={catalogBusy ? "status" : undefined}>
              {#if catalogBusy}<span class="studio-spinner studio-spinner--sm" aria-hidden="true"></span>{/if}
              {catalogBusy
                ? t("studio.catalog.loadingCatalog")
                : catalogArtistsData.length
                  ? t("studio.catalog.filterEmpty")
                  : t("studio.catalog.empty")}
            </p>
          {/each}
        </div>
      {/if}
      {#if catalogMsg}
        <p class="subtle sm">{catalogMsg}</p>
      {/if}
      {#if catalogErr}
        <p class="subtle sm warnline">{catalogErr}</p>
      {/if}
    {/if}
  </div>
</div>

<StudioCatalogPreviewDialog
  item={previewItem}
  onclose={() => (previewItem = null)}
  onDownload={(item, mode) => {
    previewItem = null;
    onSendToDownload(item, mode, webHits[item.url] ?? null);
  }}
/>
