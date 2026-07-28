<script lang="ts">
  import { CoverArt } from "@rekord/ui";
  import {
    albumCoverUrl,
    api,
    artistCoverUrl,
    type CatalogArtistEntry,
    type CatalogWebDiscover,
    type CatalogWebItem,
    type LibrarySelectionV1,
  } from "../../lib/api";
  import {
    catalogArtistNeedsAttention,
    indexHasAlbum,
    indexHasArtist,
    selectionHasAlbum,
    selectionHasArtist,
  } from "../../lib/catalogHelpers";
  import { session } from "../../lib/session.svelte";
  import UiIcon from "../icons/UiIcon.svelte";

  let {
    onSendToDownload,
  }: {
    onSendToDownload: (item: CatalogWebItem, mode: "single" | "playlist") => void;
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

  let webDiscover = $state<CatalogWebDiscover | null>(null);
  let webBusy = $state(false);
  let webErr = $state<string | null>(null);

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
      catalogErr = e instanceof Error ? e.message : String(e);
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
      catalogErr = e instanceof Error ? e.message : String(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function afterCatalogPatch() {
    catalogMsg = "Selezione aggiornata.";
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
      catalogErr = e instanceof Error ? e.message : String(e);
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
      catalogErr = e instanceof Error ? e.message : String(e);
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
      catalogErr = e instanceof Error ? e.message : String(e);
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
      catalogErr = e instanceof Error ? e.message : String(e);
    } finally {
      catalogBusy = false;
    }
  }

  async function loadWebDiscover(force = false) {
    webBusy = true;
    webErr = null;
    try {
      webDiscover = await api.catalogWebDiscover(force);
    } catch (e) {
      webErr = e instanceof Error ? e.message : String(e);
      webDiscover = { artists: [], albums: [], songs: [], error: webErr };
    } finally {
      webBusy = false;
    }
  }

  $effect(() => {
    if (catalogMode === "local") void loadCatalogPane();
    else if (!webDiscover) void loadWebDiscover();
  });
</script>

<div class="studio-pane studio-catalog-pane" role="region" aria-label="Scopri">
  <div class="studio-catalog-browse">
    <div class="studio-catalog-head">
      <p class="subtle sm studio-catalog-browse-lead">
        {catalogMode === "web"
          ? "Esplora cataloghi online e invia uscite al Download."
          : "Aggiungi artisti o singoli album dalla libreria globale alla tua selezione."}
      </p>
      <div
        class="tools-dl-studio-switch studio-catalog-head__mode-switch"
        role="group"
        aria-label="Modalità Scopri"
      >
        <span class="tools-dl-studio-switch__label" class:is-active={catalogMode === "local"}>
          Locale
        </span>
        <button
          type="button"
          role="switch"
          class="tools-dl-studio-switch__track"
          aria-checked={catalogMode === "web"}
          aria-label="Modalità Scopri"
          onclick={() => {
            catalogMode = catalogMode === "local" ? "web" : "local";
            if (catalogMode === "web") catalogArtistDetail = null;
          }}
        >
          <span class="tools-dl-studio-switch__thumb" aria-hidden="true"></span>
        </button>
        <span class="tools-dl-studio-switch__label" class:is-active={catalogMode === "web"}>
          Web
        </span>
      </div>
    </div>

    {#if catalogMode === "web"}
      <div class="studio-catalog-toolbar">
        <div class="studio-catalog-toolbar__row">
          <button
            type="button"
            class="primary-btn primary-btn--sm"
            disabled={webBusy}
            onclick={() => void loadWebDiscover(true)}
          >
            {webBusy ? "Aggiorno…" : "Aggiorna novità"}
          </button>
        </div>
      </div>
      {#if webErr}
        <p class="subtle sm warnline">{webErr}</p>
      {/if}
      <div class="library-overview-cols">
        <div class="studio-panel">
          <h4 class="studio-panel-title">
            Album ed EP
            <span style="opacity:0.65;font-weight:650;margin-left:0.35rem"
              >{webDiscover?.albums?.length ?? 0}</span
            >
          </h4>
          {#if webBusy && !webDiscover}
            <p class="panel-empty">Caricamento…</p>
          {:else if webDiscover?.albums?.length}
            {#each webDiscover.albums as item}
              <div class="studio-catalog-list-tile">
                <div class="studio-catalog-list-tile__main">
                  {#if item.thumbnailUrl}
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      width="48"
                      height="48"
                      style="border-radius:6px;object-fit:cover"
                    />
                  {/if}
                  <div>
                    <div class="library-list-tile__title">{item.title}</div>
                    <div class="library-list-tile__meta">{item.subtitle}</div>
                  </div>
                </div>
                <div class="studio-catalog-list-tile__actions">
                  <button
                    type="button"
                    class="primary-btn"
                    onclick={() => onSendToDownload(item, "playlist")}
                  >
                    Scarica
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <p class="panel-empty">Nessun risultato web.</p>
          {/if}
        </div>
        <div class="studio-panel">
          <h4 class="studio-panel-title">
            Singoli
            <span style="opacity:0.65;font-weight:650;margin-left:0.35rem"
              >{webDiscover?.songs?.length ?? 0}</span
            >
          </h4>
          {#if webDiscover?.songs?.length}
            {#each webDiscover.songs as item}
              <div class="studio-catalog-list-tile">
                <div class="studio-catalog-list-tile__main">
                  <div>
                    <div class="library-list-tile__title">{item.title}</div>
                    <div class="library-list-tile__meta">{item.subtitle}</div>
                  </div>
                </div>
                <div class="studio-catalog-list-tile__actions">
                  <button
                    type="button"
                    class="primary-btn"
                    onclick={() => onSendToDownload(item, "single")}
                  >
                    Scarica
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <p class="panel-empty">Nessun risultato web.</p>
          {/if}
        </div>
      </div>
    {:else}
      <div class="studio-catalog-toolbar">
        <div class="studio-catalog-toolbar__row">
          <button
            type="button"
            class="primary-btn primary-btn--sm"
            disabled={catalogBusy}
            onclick={() => void loadCatalogPane(true)}
          >
            {catalogBusy ? "Aggiorno…" : "Aggiorna elenco"}
          </button>
          {#if !catalogArtistDetail}
            <input
              type="search"
              class="ghost-input ghost-input--search studio-catalog-toolbar__search"
              placeholder="Cerca artisti…"
              aria-label="Cerca artisti"
              bind:value={catalogQuery}
            />
          {/if}
        </div>
        {#if !catalogArtistDetail}
          <label class="studio-catalog-toolbar__check">
            <input type="checkbox" bind:checked={catalogOnlyAttention} />
            <span>Mostra solo artisti non nella mia selezione / da aggiornare</span>
          </label>
        {/if}
        {#if selectionIncludeAll}
          <p class="subtle sm">
            Selezione = tutta la libreria (includeAll). Aggiungi/Rimuovi sono disabilitati.
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
                  catalogErr = e instanceof Error ? e.message : String(e);
                } finally {
                  catalogBusy = false;
                }
              }}
            >
              Usa selezione manuale
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
              aria-label="Artisti"
              onclick={() => (catalogArtistDetail = null)}
            >
              <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
            </button>
            <div class="page-toolbar__textcol">
              <p class="rk-eyebrow">Album</p>
              <h2>{catalogArtistDetail.name}</h2>
            </div>
          </div>
        </div>
        <div class="library-overview-cols">
          {#each catalogArtistDetail.rel_albums as al}
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
                  src={al.has_cover ? albumCoverUrl(al.id) : ""}
                  size="tile"
                />
                <div>
                  <div class="library-list-tile__title-row">
                    <UiIcon name="album" class="library-list-tile__kind-ic" />
                    <div class="library-list-tile__title">{al.name}</div>
                  </div>
                  <div class="library-list-tile__meta">{al.track_count} brani</div>
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
                    Rimuovi dalla libreria
                  </button>
                {:else}
                  <button
                    type="button"
                    class="primary-btn"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void addAlbumCatalog(al.folder_key)}
                  >
                    Aggiungi alla libreria
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <p class="studio-catalog-filter-empty">Nessun album nel catalogo per questo artista.</p>
          {/each}
        </div>
      {:else}
        <div class="library-overview-cols">
          {#each catalogArtists as artist}
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
                  src={artist.has_cover && coverId ? artistCoverUrl(coverId) : ""}
                  size="tile"
                />
                <div>
                  <div class="library-list-tile__title-row">
                    <UiIcon name="person" class="library-list-tile__kind-ic" />
                    <div class="library-list-tile__title">{artist.name}</div>
                  </div>
                  <div class="library-list-tile__meta">
                    {artist.album_count} album · {artist.track_count} brani
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
                    Rimuovi dalla libreria
                  </button>
                {:else}
                  <button
                    type="button"
                    class="primary-btn"
                    disabled={catalogBusy || selectionIncludeAll}
                    onclick={() => void addArtistCatalog(artist.id)}
                  >
                    Aggiungi alla libreria
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <p class="studio-catalog-filter-empty">
              {catalogBusy
                ? "Caricamento catalogo…"
                : catalogArtistsData.length
                  ? "Nessun artista corrisponde alla ricerca o al filtro."
                  : "Nessun artista nel catalogo globale. Esegui uno scan della libreria."}
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
