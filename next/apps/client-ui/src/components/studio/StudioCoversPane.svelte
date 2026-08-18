<script lang="ts">
  import { onMount } from "svelte";
  import { api, type ArtworkHit, type Album } from "../../lib/api";
  import { session } from "../../lib/session.svelte";
  import UiIcon from "../icons/UiIcon.svelte";

  let coverArtist = $state("");
  let coverAlbumId = $state<number | null>(null);
  let artQuery = $state("");
  let coverAlbums = $state<Album[]>([]);
  let results = $state<ArtworkHit[]>([]);
  let busy = $state(false);
  let err = $state<string | null>(null);
  let msg = $state<string | null>(null);
  let didAutofill = $state(false);

  const artistsSorted = $derived(
    session.artists.slice().sort((a, b) => a.name.localeCompare(b.name, "it")),
  );

  const selectedAlbum = $derived(
    coverAlbumId != null ? coverAlbums.find((a) => a.id === coverAlbumId) : null,
  );

  function loadCoverAlbums(artistName: string) {
    coverAlbums = artistName
      ? session.allAlbums.filter((a) => a.artist_name === artistName && !a.loose)
      : [];
  }

  function fillFromPlayback() {
    if (!session.current) return;
    coverArtist = session.current.artist_name;
    loadCoverAlbums(coverArtist);
    coverAlbumId = session.current.album_id;
    artQuery = `${session.current.artist_name} ${session.current.album_name}`;
  }

  onMount(() => {
    if (!didAutofill && session.current) {
      fillFromPlayback();
      didAutofill = true;
    }
  });

  $effect(() => {
    if (session.studioPane === "covers" && session.current && !coverAlbumId) {
      fillFromPlayback();
    }
  });

  async function search() {
    if (!selectedAlbum && !artQuery.trim()) {
      err = "Scegli un album o inserisci una ricerca.";
      return;
    }
    busy = true;
    err = null;
    msg = null;
    try {
      const q =
        artQuery.trim() ||
        `${selectedAlbum?.artist_name ?? ""} ${selectedAlbum?.name ?? ""}`.trim();
      const r = await api.artworkSearch({
        q,
        artist: selectedAlbum?.artist_name || coverArtist || undefined,
        album: selectedAlbum?.name || undefined,
      });
      results = r.results || [];
      if (!results.length) msg = "Nessuna copertina trovata.";
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      results = [];
    } finally {
      busy = false;
    }
  }

  async function apply(hit: ArtworkHit) {
    if (!selectedAlbum) {
      err = "Seleziona l’album di destinazione.";
      return;
    }
    busy = true;
    err = null;
    try {
      await api.artworkApply(selectedAlbum.folder_key, hit.artwork);
      msg = `Copertina salvata su ${selectedAlbum.folder_key}`;
      await session.loadAllAlbums();
      loadCoverAlbums(coverArtist);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function openLink(hit: ArtworkHit) {
    const href = hit.url || hit.artwork;
    if (!href) return;
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function linkLabel(hit: ArtworkHit): string {
    try {
      const u = new URL(hit.url || hit.artwork);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return "Apri";
    }
  }
</script>

<div class="studio-pane tools-art" role="region" aria-label="Copertine">
  <div class="studio-covers-split">
    <div class="studio-panel">
      <h4 class="studio-panel-title">Salvataggio</h4>
      <div class="studio-picker-picks tools-studio-pair-picks tools-cover-save-picks">
        <div>
          <label class="subtle sm block-label" for="cover-artist-sel">Artista</label>
          <select
            id="cover-artist-sel"
            class="rk-select"
            bind:value={coverArtist}
            onchange={() => {
              coverAlbumId = null;
              loadCoverAlbums(coverArtist);
            }}
            aria-label="Artista"
          >
            <option value="">Scegli…</option>
            {#each artistsSorted as a}
              <option value={a.name}>{a.name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="subtle sm block-label" for="cover-album-sel">Album</label>
          <select
            id="cover-album-sel"
            class="rk-select"
            value={coverAlbumId ?? ""}
            disabled={!coverArtist}
            aria-label="Album"
            onchange={(e) => {
              const v = e.currentTarget.value;
              coverAlbumId = v ? Number(v) : null;
              const al = coverAlbums.find((a) => a.id === coverAlbumId);
              if (al) artQuery = `${al.artist_name} ${al.name}`;
            }}
          >
            {#if !coverArtist}
              <option value="">Prima scegli un artista</option>
            {:else}
              <option value="">Scegli album…</option>
              {#each coverAlbums as al}
                <option value={al.id}>{al.name}</option>
              {/each}
            {/if}
          </select>
        </div>
      </div>
      {#if selectedAlbum}
        <p class="art-target sm"><code>{selectedAlbum.folder_key}</code></p>
      {/if}
    </div>

    <div class="studio-panel">
      <h4 class="studio-panel-title">Ricerca</h4>
      <div class="art-fields">
        <label class="art-field">
          <span class="subtle sm block-label">Cerca copertina</span>
          <input
            type="text"
            class="ghost-input"
            bind:value={artQuery}
            placeholder="Artista Album"
            disabled={busy}
          />
        </label>
      </div>
      <div class="studio-inline-actions studio-inline-actions--spaced">
        <button
          type="button"
          class="ghost-btn ghost-btn--sm"
          disabled={!session.current}
          onclick={fillFromPlayback}
        >
          Compila da riproduzione
        </button>
        <button
          type="button"
          class="primary-btn"
          disabled={busy}
          onclick={() => void search()}
        >
          {busy ? "Cerco…" : "Cerca copertine"}
        </button>
      </div>
    </div>
  </div>

  {#if err}
    <p class="subtle sm warnline">{err}</p>
  {/if}
  {#if msg}
    <p class="subtle sm">{msg}</p>
  {/if}

  <div class="artgrid2">
    {#each results as hit}
      <div class="artcard2">
        <div class="artcard2-img">
          <img src={hit.artwork} alt={hit.name} loading="lazy" />
          <span class="art-src">{hit.source || "—"}</span>
        </div>
        <div class="artcap2">
          <strong>{hit.artist}</strong><br />{hit.name}
        </div>
        <div class="art-actions">
          <a
            class="extlink"
            href={hit.url || hit.artwork}
            target="_blank"
            rel="noreferrer"
            onclick={(e) => {
              e.preventDefault();
              openLink(hit);
            }}
          >
            {linkLabel(hit)}
          </a>
          <button
            type="button"
            class="primary-btn primary-btn--sm"
            disabled={busy || !selectedAlbum}
            onclick={() => void apply(hit)}
          >
            Salva copertina
          </button>
        </div>
      </div>
    {:else}
      {#each [1, 2, 3] as _}
        <div class="artcard2" aria-hidden="true">
          <div class="artcard2-img">
            <UiIcon name="image" />
            <span class="art-src">—</span>
          </div>
          <div class="artcap2">Nessun risultato</div>
        </div>
      {/each}
    {/each}
  </div>
</div>
