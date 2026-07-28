<script lang="ts">
  import UiIcon from "../icons/UiIcon.svelte";
  import {
    api,
    type DiscogsCandidate,
  } from "../../lib/api";
  import { session } from "../../lib/session.svelte";

  let metaArtist = $state("");
  let metaAlbumId = $state<number | null>(null);
  let metaOptionalOpen = $state(false);
  let metaLog = $state("");
  let busy = $state(false);
  let err = $state<string | null>(null);
  let candidates = $state<DiscogsCandidate[]>([]);
  let entityCandidates = $state<
    Array<{ kind?: string; lang: string; title?: string; text: string }>
  >([]);
  let selectedEntity = $state<Set<number>>(new Set());

  const artistsSorted = $derived(
    session.artists.slice().sort((a, b) => a.name.localeCompare(b.name, "it")),
  );
  const metaAlbums = $derived(
    metaArtist
      ? session.allAlbums.filter((a) => a.artist_name === metaArtist)
      : [],
  );
  const selectedAlbum = $derived(
    metaAlbumId != null ? metaAlbums.find((a) => a.id === metaAlbumId) : null,
  );

  function appendLog(line: string) {
    metaLog = (metaLog ? `${metaLog}\n` : "") + line;
  }

  async function fetchAlbum() {
    if (!selectedAlbum) return;
    busy = true;
    err = null;
    candidates = [];
    try {
      const artist = selectedAlbum.artist_name;
      const album = selectedAlbum.name;
      const discogs = await api.discogsSearchReleases(artist, album);
      candidates = discogs.candidates || [];
      if (candidates.length) {
        appendLog(`Discogs: ${candidates.length} candidati.`);
      } else {
        appendLog("Nessun candidato Discogs — fallback provider…");
        const r = await api.albumInfoFetch(selectedAlbum.folder_key, artist, album);
        appendLog(
          `Album fetch ok (${String((r.meta as { source?: string })?.source || "?")}).`,
        );
        await session.loadAllAlbums();
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Errore: ${err}`);
    } finally {
      busy = false;
    }
  }

  async function applyDiscogs(c: DiscogsCandidate) {
    if (!selectedAlbum) return;
    busy = true;
    err = null;
    try {
      await api.discogsApplyRelease(
        selectedAlbum.folder_key,
        c.releaseId,
        selectedAlbum.artist_name,
        selectedAlbum.name,
      );
      appendLog(`Applicato Discogs #${c.releaseId}: ${c.title}`);
      candidates = [];
      await session.loadAllAlbums();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Errore apply: ${err}`);
    } finally {
      busy = false;
    }
  }

  async function fetchTracks() {
    if (!selectedAlbum) return;
    busy = true;
    err = null;
    try {
      const r = await api.trackInfoFetchAlbum(selectedAlbum.folder_key);
      appendLog(`Brani: ${r.fetched} ok, ${r.failed} errori.`);
      await session.refreshAll();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Errore: ${err}`);
    } finally {
      busy = false;
    }
  }

  async function loadEntityInfo() {
    if (!metaArtist) return;
    busy = true;
    err = null;
    try {
      const albumName = selectedAlbum?.name;
      const r = await api.entityInfoSearch(metaArtist, albumName, "it");
      entityCandidates = r.candidates || [];
      selectedEntity = new Set();
      appendLog(`Curiosità: ${entityCandidates.length} candidati.`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function saveEntityInfo() {
    if (!metaArtist) return;
    const add = [...selectedEntity].map((i) => entityCandidates[i]).filter(Boolean);
    if (!add.length) {
      err = "Seleziona almeno una voce.";
      return;
    }
    busy = true;
    try {
      await api.entityInfoSave({
        artist: metaArtist,
        album: selectedAlbum?.name || null,
        add: add.map((c) => ({
          lang: c.lang || "it",
          title: c.title,
          text: c.text,
        })),
      });
      appendLog(`Salvate ${add.length} curiosità.`);
      entityCandidates = [];
      selectedEntity = new Set();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="studio-pane tools-meta" role="region" aria-label="Metadati">
  <div class="studio-meta-split">
    <div class="studio-meta-split__primary">
      <div class="studio-panel studio-meta-picks">
        <div class="studio-picker-picks tools-studio-pair-picks">
          <div>
            <label class="subtle sm block-label" for="meta-artist-sel">Artista</label>
            <select
              id="meta-artist-sel"
              class="select"
              bind:value={metaArtist}
              onchange={() => (metaAlbumId = null)}
              aria-label="Artista"
            >
              <option value="">Scegli…</option>
              {#each artistsSorted as a}
                <option value={a.name}>{a.name}</option>
              {/each}
            </select>
          </div>
          <div>
            <label class="subtle sm block-label" for="meta-album-sel">Album</label>
            <select
              id="meta-album-sel"
              class="select"
              value={metaAlbumId ?? ""}
              disabled={!metaArtist}
              aria-label="Album"
              onchange={(e) => {
                const v = e.currentTarget.value;
                metaAlbumId = v ? Number(v) : null;
              }}
            >
              {#if !metaArtist}
                <option value="">Prima scegli un artista</option>
              {:else}
                <option value="">Scegli album…</option>
                {#each metaAlbums as al}
                  <option value={al.id}>{al.name}</option>
                {/each}
              {/if}
            </select>
          </div>
        </div>
        {#if selectedAlbum}
          <p class="art-target sm">Cartella: {selectedAlbum.folder_key}</p>
        {/if}
        <div class="studio-action-row studio-meta-fill-row">
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            disabled={!session.current}
            onclick={() => {
              if (!session.current) return;
              metaArtist = session.current.artist_name;
              metaAlbumId = session.current.album_id;
            }}
          >
            Compila da riproduzione
          </button>
        </div>
      </div>

      <div class="studio-panel studio-meta-essentials">
        <h4 class="studio-panel-title">Essenziali</h4>
        <div class="studio-action-groups">
          <div class="studio-action-group">
            <span class="studio-action-group-label">Album</span>
            <p class="subtle sm studio-meta-essentials-hint">
              Arricchisci metadati album da Discogs / MusicBrainz / iTunes.
            </p>
            <div class="studio-action-row studio-meta-equal-btns">
              <button
                type="button"
                class="primary-btn"
                disabled={!metaAlbumId || busy}
                onclick={() => void fetchAlbum()}
              >
                {busy ? "…" : "Album selezionato"}
              </button>
            </div>
          </div>
          <div class="studio-action-group">
            <span class="studio-action-group-label">Brani</span>
            <p class="subtle sm studio-meta-essentials-hint">
              Metadati traccia per l’album selezionato (Deezer / iTunes / TheAudioDB).
            </p>
            <div class="studio-action-row studio-meta-equal-btns">
              <button
                type="button"
                class="primary-btn"
                disabled={!metaAlbumId || busy}
                onclick={() => void fetchTracks()}
              >
                Metadati brani album selezionato
              </button>
            </div>
          </div>
        </div>
        {#if candidates.length}
          <div class="studio-panel-gap">
            <p class="subtle sm">Scegli release Discogs:</p>
            {#each candidates as c}
              <div class="studio-catalog-list-tile">
                <div class="studio-catalog-list-tile__main">
                  <div>
                    <div class="library-list-tile__title">{c.title}</div>
                    <div class="library-list-tile__meta">
                      score {c.score}
                      {#if c.year}· {c.year}{/if}
                      {#if c.country}· {c.country}{/if}
                    </div>
                  </div>
                </div>
                <div class="studio-catalog-list-tile__actions">
                  <button
                    type="button"
                    class="primary-btn primary-btn--sm"
                    disabled={busy}
                    onclick={() => void applyDiscogs(c)}
                  >
                    Applica
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="studio-log">
        <label class="subtle sm" for="studio-meta-log">Log</label>
        <textarea id="studio-meta-log" class="log rk-scroll" rows="3" bind:value={metaLog}
        ></textarea>
        <button type="button" class="linkbtn" onclick={() => (metaLog = "")}>Pulisci</button>
      </div>
      {#if err}
        <p class="subtle sm warnline">{err}</p>
      {/if}
    </div>

    <div class="studio-meta-split__secondary">
      <div class="studio-meta-optional">
        <button
          type="button"
          class="studio-meta-optional__toggle"
          aria-expanded={metaOptionalOpen}
          onclick={() => (metaOptionalOpen = !metaOptionalOpen)}
        >
          <span>Opzionali</span>
          <UiIcon
            name="chevronRight"
            class="studio-meta-optional__chev{metaOptionalOpen ? ' is-open' : ''}"
          />
        </button>
        {#if metaOptionalOpen}
          <div class="studio-meta-optional__body studio-action-groups">
            <div class="studio-einfo">
              <p class="studio-einfo-title">Info e curiosità</p>
              <p class="subtle sm">
                Cerca biografie/descrizioni (Wikipedia) e salvale nella cartella artista/album.
              </p>
              <div class="studio-action-row">
                <button
                  type="button"
                  class="ghost-btn ghost-btn--sm"
                  disabled={!metaArtist || busy}
                  onclick={() => void loadEntityInfo()}
                >
                  Carica info
                </button>
                <button
                  type="button"
                  class="primary-btn primary-btn--sm"
                  disabled={!selectedEntity.size || busy}
                  onclick={() => void saveEntityInfo()}
                >
                  Salva selezionate
                </button>
              </div>
              {#each entityCandidates as c, i}
                <label class="check">
                  <input
                    type="checkbox"
                    checked={selectedEntity.has(i)}
                    onchange={(e) => {
                      const next = new Set(selectedEntity);
                      if (e.currentTarget.checked) next.add(i);
                      else next.delete(i);
                      selectedEntity = next;
                    }}
                  />
                  <strong>{c.title || c.kind || "voce"}</strong>
                  <span class="subtle sm"> — {c.text.slice(0, 120)}…</span>
                </label>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
