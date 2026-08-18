<script lang="ts">
  import { onMount } from "svelte";
  import { sheetDrag, SHEET_MEDIA_QUERY } from "@rekord/ui";
  import UiIcon from "../icons/UiIcon.svelte";
  import {
    api,
    type DiscogsCandidate,
    type Track,
  } from "../../lib/api";
  import { session } from "../../lib/session.svelte";

  /* Su telefono i due dialoghi sono fogli dal basso, spingibili giù per chiudere. */
  let isSheet = $state(false);

  $effect(() => {
    const mq = window.matchMedia(SHEET_MEDIA_QUERY);
    const sync = () => {
      isSheet = mq.matches;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });

  let metaArtist = $state("");
  let metaAlbumId = $state<number | null>(null);
  let metaOptionalOpen = $state(false);
  let metaLog = $state("");
  let busy = $state(false);
  let err = $state<string | null>(null);
  let candidates = $state<DiscogsCandidate[]>([]);
  let discogsOpen = $state(false);
  let entityCandidates = $state<
    Array<{ kind?: string; lang: string; title?: string; text: string }>
  >([]);
  let selectedEntity = $state<Set<number>>(new Set());

  let scanChoice = $state<null | "album" | "track">(null);
  let metaScanProg = $state<{ current: number; total: number } | null>(null);
  let trackScanProg = $state<{ current: number; total: number } | null>(null);
  let pruneProg = $state<{ current: number; total: number } | null>(null);
  let metaAllBusy = $state(false);
  let trackAllBusy = $state(false);
  let pruneBusy = $state(false);
  let titleSanBusy = $state(false);
  let stopMeta = $state(false);
  let stopTrack = $state(false);
  let stopPrune = $state(false);
  let discogsConfigured = $state(true);

  const artistsSorted = $derived(
    session.artists.slice().sort((a, b) => a.name.localeCompare(b.name, "it")),
  );
  const metaAlbums = $derived(
    metaArtist
      ? session.allAlbums.filter((a) => a.artist_name === metaArtist && !a.loose)
      : [],
  );
  const selectedAlbum = $derived(
    metaAlbumId != null ? metaAlbums.find((a) => a.id === metaAlbumId) : null,
  );
  const studioBusy = $derived(
    busy || metaAllBusy || trackAllBusy || pruneBusy || titleSanBusy,
  );

  onMount(() => {
    void api
      .config()
      .then((c) => {
        discogsConfigured = !!c.discogsConfigured;
      })
      .catch(() => {});
    fillFromPlayback();
  });

  function appendLog(line: string) {
    metaLog = (metaLog ? `${metaLog}\n` : "") + line;
  }

  function fillFromPlayback() {
    if (!session.current) return;
    metaArtist = session.current.artist_name;
    metaAlbumId = session.current.album_id;
  }

  async function fetchAlbum() {
    if (!selectedAlbum) return;
    busy = true;
    err = null;
    candidates = [];
    try {
      const artist = selectedAlbum.artist_name;
      const album = selectedAlbum.name;
      if (discogsConfigured) {
        try {
          const discogs = await api.discogsSearchReleases(artist, album);
          candidates = discogs.candidates || [];
          if (candidates.length) {
            appendLog(`Discogs: ${candidates.length} candidati.`);
            discogsOpen = true;
            busy = false;
            return;
          }
          appendLog("Nessun candidato Discogs — fallback provider…");
        } catch (e) {
          appendLog(
            `Discogs non disponibile (${e instanceof Error ? e.message : e}) — fallback…`,
          );
        }
      }
      const r = await api.albumInfoFetch(selectedAlbum.folder_key, artist, album);
      appendLog(
        `Album fetch ok (${String((r.meta as { source?: string })?.source || "?")}).`,
      );
      await session.loadAllAlbums();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Errore: ${err}`);
    } finally {
      busy = false;
    }
  }

  async function applyDiscogs(c: DiscogsCandidate) {
    if (!selectedAlbum) return;
    discogsOpen = false;
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
    trackScanProg = { current: 0, total: 1 };
    try {
      const r = await api.trackInfoFetchAlbum(selectedAlbum.folder_key);
      const total = r.fetched + r.failed;
      if (total > 0) trackScanProg = { current: total, total };
      appendLog(`Brani: ${r.fetched} ok, ${r.failed} errori.`);
      await session.refreshAll();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Errore: ${err}`);
    } finally {
      busy = false;
      trackScanProg = null;
    }
  }

  async function runMetaScanAll(rescanAll: boolean) {
    stopMeta = false;
    metaAllBusy = true;
    metaScanProg = null;
    const list = session.allAlbums.filter((a) => !a.loose && a.folder_key);
    const toFetch = rescanAll
      ? list
      : list.filter((a) => !a.has_album_meta);
    const skipped = list.length - toFetch.length;
    appendLog(
      `${rescanAll ? "Riscan completo album. " : ""}Scan album: ${toFetch.length} da aggiornare` +
        (skipped ? ` (${skipped} già ok)` : "") +
        ".",
    );
    if (!toFetch.length) {
      appendLog("Nessun album da aggiornare.");
      metaAllBusy = false;
      return;
    }
    for (let i = 0; i < toFetch.length; i++) {
      if (stopMeta) {
        appendLog("Scan album interrotto.");
        break;
      }
      const al = toFetch[i]!;
      metaScanProg = { current: i + 1, total: toFetch.length };
      try {
        await api.albumInfoFetch(al.folder_key, al.artist_name, al.name);
      } catch (e) {
        appendLog(
          `Album ${i + 1}/${toFetch.length} ${al.folder_key}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    metaScanProg = null;
    metaAllBusy = false;
    appendLog("Scan album completato.");
    await session.loadAllAlbums();
  }

  async function runTrackScanAll(rescanAll: boolean) {
    stopTrack = false;
    trackAllBusy = true;
    trackScanProg = null;
    let tracks: Track[] = [];
    try {
      tracks = await api.tracks(50_000, 0);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      trackAllBusy = false;
      return;
    }
    const toFetch = rescanAll
      ? tracks
      : tracks.filter((t) => !(t.genre?.trim() || t.release_date?.trim()));
    const skipped = tracks.length - toFetch.length;
    appendLog(
      `${rescanAll ? "Riscan completo brani. " : ""}Scan brani: ${toFetch.length}` +
        (skipped ? ` (${skipped} già ok)` : "") +
        ".",
    );
    if (!toFetch.length) {
      appendLog("Nessun brano da aggiornare.");
      trackAllBusy = false;
      return;
    }
    for (let i = 0; i < toFetch.length; i++) {
      if (stopTrack) {
        appendLog("Scan brani interrotto.");
        break;
      }
      const t = toFetch[i]!;
      trackScanProg = { current: i + 1, total: toFetch.length };
      try {
        await api.trackInfoFetch(t.rel_path);
      } catch (e) {
        appendLog(
          `Brano ${i + 1}/${toFetch.length} ${t.rel_path}: ${e instanceof Error ? e.message : e}`,
        );
      }
      if (i < toFetch.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    trackScanProg = null;
    trackAllBusy = false;
    appendLog("Scan brani completato.");
    await session.refreshAll();
  }

  async function runPruneAll() {
    if (!confirm("Pulire metadati orfani su tutti gli album? Operazione irreversibile sui sidecar.")) {
      return;
    }
    stopPrune = false;
    pruneBusy = true;
    pruneProg = null;
    const list = session.allAlbums.filter((a) => !a.loose && a.folder_key);
    appendLog(`Prune orfani: ${list.length} album…`);
    let touched = 0;
    for (let i = 0; i < list.length; i++) {
      if (stopPrune) {
        appendLog("Prune interrotto.");
        break;
      }
      const al = list[i]!;
      pruneProg = { current: i + 1, total: list.length };
      try {
        const r = await api.pruneAlbumMetadata(al.folder_key);
        if (r.written || r.removed?.length) {
          touched += 1;
          if (r.removed?.length) {
            appendLog(
              `Prune ${al.folder_key}: rimossi ${r.removed.slice(0, 6).join(", ")}${r.removed.length > 6 ? "…" : ""}`,
            );
          }
        }
      } catch (e) {
        appendLog(`Prune ${al.folder_key}: ${e instanceof Error ? e.message : e}`);
      }
    }
    pruneProg = null;
    pruneBusy = false;
    appendLog(`Prune completato (${touched} album toccati).`);
  }

  async function runSanitize(scope: "album" | "all", dryRun: boolean) {
    if (scope === "album" && !selectedAlbum) {
      appendLog("Scegli un album per sanificare i titoli.");
      return;
    }
    titleSanBusy = true;
    err = null;
    try {
      const r = await api.sanitizeTrackTitles({
        scope,
        albumPath: scope === "album" ? selectedAlbum!.folder_key : undefined,
        dryRun,
      });
      const head = dryRun
        ? scope === "all"
          ? `Anteprima titoli libreria (${r.changes.length}):\n`
          : `Anteprima titoli — ${selectedAlbum!.folder_key}\n`
        : scope === "all"
          ? `Scrittura titoli libreria (${r.changes.length}):\n`
          : `Scrittura titoli — ${selectedAlbum!.folder_key}\n`;
      if (!r.changes.length) {
        appendLog(head + "Nessuna correzione necessaria.\n");
      } else {
        let body = head;
        for (const c of r.changes.slice(0, 100)) {
          body += `  ${c.fileName}: «${c.from}» → «${c.to}»\n`;
        }
        if (r.changes.length > 100) {
          body += `  … e altre ${r.changes.length - 100} voci.\n`;
        }
        if (!dryRun) body += "Ricarica la libreria per vedere i titoli aggiornati.\n";
        appendLog(body);
      }
      if (!dryRun && r.changes.length) await session.refreshAll();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      appendLog(`Titoli: ${err}`);
    } finally {
      titleSanBusy = false;
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

  const albumScanPct = $derived(
    metaScanProg && metaScanProg.total > 0
      ? Math.max(2, Math.min(100, (metaScanProg.current / metaScanProg.total) * 100))
      : 0,
  );
  const trackScanPct = $derived(
    trackScanProg && trackScanProg.total > 0
      ? Math.max(2, Math.min(100, (trackScanProg.current / trackScanProg.total) * 100))
      : 0,
  );
  const prunePct = $derived(
    pruneProg && pruneProg.total > 0
      ? Math.max(2, Math.min(100, (pruneProg.current / pruneProg.total) * 100))
      : 0,
  );
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
              class="rk-select"
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
              class="rk-select"
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
            disabled={!session.current || studioBusy}
            onclick={fillFromPlayback}
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
                disabled={!metaAlbumId || studioBusy}
                onclick={() => void fetchAlbum()}
              >
                {busy ? "…" : "Album selezionato"}
              </button>
              <button
                type="button"
                class="ghost-btn"
                disabled={!session.allAlbums.length || studioBusy}
                title="Scan automatico su tutta la libreria"
                onclick={() => (scanChoice = "album")}
              >
                {metaAllBusy ? "Scan…" : "Scan automatico"}
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
                disabled={!metaAlbumId || studioBusy}
                onclick={() => void fetchTracks()}
              >
                Metadati brani album selezionato
              </button>
              <button
                type="button"
                class="ghost-btn"
                disabled={!session.allAlbums.length || studioBusy}
                onclick={() => (scanChoice = "track")}
              >
                {trackAllBusy ? "Scan…" : "Scan tutti i brani"}
              </button>
            </div>
          </div>
        </div>

        {#if metaAllBusy && metaScanProg && metaScanProg.total > 0}
          <div class="dl-progress-wrap">
            <div class="dl-progress-top">
              <span>Metadati album</span>
              <span>{metaScanProg.current}/{metaScanProg.total}</span>
            </div>
            <div class="dl-progress-rail">
              <div class="dl-progress-fill" style="width: {albumScanPct}%"></div>
            </div>
          </div>
        {/if}
        {#if trackAllBusy && trackScanProg && trackScanProg.total > 0}
          <div class="dl-progress-wrap">
            <div class="dl-progress-top">
              <span>Metadati brani</span>
              <span>{trackScanProg.current}/{trackScanProg.total}</span>
            </div>
            <div class="dl-progress-rail">
              <div class="dl-progress-fill" style="width: {trackScanPct}%"></div>
            </div>
          </div>
        {/if}
        {#if pruneBusy && pruneProg && pruneProg.total > 0}
          <div class="dl-progress-wrap">
            <div class="dl-progress-top">
              <span>Pulizia orfani</span>
              <span>{pruneProg.current}/{pruneProg.total}</span>
            </div>
            <div class="dl-progress-rail">
              <div class="dl-progress-fill" style="width: {prunePct}%"></div>
            </div>
          </div>
        {/if}
        {#if metaAllBusy || trackAllBusy || pruneBusy}
          <div class="studio-stop-row">
            {#if metaAllBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                onclick={() => (stopMeta = true)}
              >
                Stop album
              </button>
            {/if}
            {#if trackAllBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                onclick={() => (stopTrack = true)}
              >
                Stop brani
              </button>
            {/if}
            {#if pruneBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                onclick={() => (stopPrune = true)}
              >
                Stop prune
              </button>
            {/if}
          </div>
        {/if}

        <div class="studio-meta-if-needed">
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            disabled={!session.allAlbums.length || studioBusy}
            title="Rimuove chiavi orfane dai sidecar kord-trackinfo"
            onclick={() => void runPruneAll()}
          >
            {pruneBusy ? "…" : "Pulisci meta brani orfani"}
          </button>
        </div>
      </div>

      <div class="studio-log">
        <label class="subtle sm" for="studio-meta-log">Log</label>
        <textarea
          id="studio-meta-log"
          class="rk-textarea log rk-scroll"
          rows="3"
          bind:value={metaLog}
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
            <div class="studio-action-group">
              <span class="studio-action-group-label">Titoli file</span>
              <p class="subtle sm studio-hint-line">
                Pulisce numerazione, tag YouTube e prefissi artista dai titoli locali.
              </p>
              <div class="studio-action-row studio-meta-equal-btns">
                <button
                  type="button"
                  class="ghost-btn"
                  disabled={!selectedAlbum || studioBusy}
                  onclick={() => void runSanitize("album", true)}
                >
                  {titleSanBusy ? "…" : "Anteprima album"}
                </button>
                <button
                  type="button"
                  class="primary-btn"
                  disabled={!selectedAlbum || studioBusy}
                  onclick={() => void runSanitize("album", false)}
                >
                  {titleSanBusy ? "…" : "Applica album"}
                </button>
              </div>
              <div class="studio-action-row studio-meta-equal-btns">
                <button
                  type="button"
                  class="ghost-btn"
                  disabled={!session.allAlbums.length || studioBusy}
                  onclick={() => void runSanitize("all", true)}
                >
                  {titleSanBusy ? "…" : "Anteprima libreria"}
                </button>
                <button
                  type="button"
                  class="primary-btn"
                  disabled={!session.allAlbums.length || studioBusy}
                  onclick={() => void runSanitize("all", false)}
                >
                  {titleSanBusy ? "…" : "Applica libreria"}
                </button>
              </div>
            </div>
            <div class="studio-einfo">
              <p class="studio-einfo-title">Info e curiosità</p>
              <p class="subtle sm">
                Cerca biografie/descrizioni (Wikipedia) e salvale nella cartella artista/album.
              </p>
              <div class="studio-action-row">
                <button
                  type="button"
                  class="ghost-btn ghost-btn--sm"
                  disabled={!metaArtist || studioBusy}
                  onclick={() => void loadEntityInfo()}
                >
                  Carica info
                </button>
                <button
                  type="button"
                  class="primary-btn primary-btn--sm"
                  disabled={!selectedEntity.size || studioBusy}
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

{#if discogsOpen && candidates.length}
  <div
    class="meta-edit-backdrop rk-sheet-back"
    role="presentation"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) discogsOpen = false;
    }}
  >
    <div
      class="meta-edit-dialog rk-sheet surface-card studio-discogs-picker"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-labelledby="discogs-picker-title"
      onmousedown={(e) => e.stopPropagation()}
      use:sheetDrag={{
        enabled: isSheet,
        gripSelector: "[data-sheet-grip]",
        onclose: () => (discogsOpen = false),
      }}
    >
      <div class="rk-sheet__grip" data-sheet-grip aria-hidden="true"></div>
      <div class="section-head" data-sheet-grip>
        <div>
          <h2 id="discogs-picker-title">Scegli release Discogs</h2>
          <p class="subtle sm">Seleziona la release corretta per applicare metadati album e brani.</p>
        </div>
        <button type="button" class="text-btn" onclick={() => (discogsOpen = false)}>
          Annulla
        </button>
      </div>
      <ul class="studio-discogs-picker__list rk-scroll" data-sheet-body>
        {#each candidates as c}
          <li>
            <button
              type="button"
              class="studio-discogs-picker__item"
              disabled={busy}
              onclick={() => void applyDiscogs(c)}
            >
              {#if c.thumb}
                <img src={c.thumb} alt="" class="studio-discogs-picker__thumb" />
              {/if}
              <span class="studio-discogs-picker__body">
                <span class="studio-discogs-picker__title">{c.title}</span>
                <span class="subtle sm">
                  {[c.year, c.country, c.label, `score ${c.score}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}

{#if scanChoice}
  <div
    class="meta-edit-backdrop rk-sheet-back"
    role="presentation"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) scanChoice = null;
    }}
  >
    <div
      class="meta-edit-dialog rk-sheet surface-card studio-scan-choice"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-labelledby="scan-choice-title"
      onmousedown={(e) => e.stopPropagation()}
      use:sheetDrag={{
        enabled: isSheet,
        gripSelector: "[data-sheet-grip]",
        onclose: () => (scanChoice = null),
      }}
    >
      <div class="rk-sheet__grip" data-sheet-grip aria-hidden="true"></div>
      <h4 class="studio-scan-choice__title" id="scan-choice-title" data-sheet-grip>
        {scanChoice === "album" ? "Scan metadati album" : "Scan metadati brani"}
      </h4>
      <p class="subtle sm studio-scan-choice__hint">
        {scanChoice === "album"
          ? "Scegli se aggiornare solo gli album senza meta, o riscrivere tutti."
          : "Scegli se aggiornare solo i brani senza genere/data, o tutti."}
      </p>
      <div class="studio-scan-choice__actions">
        <button
          type="button"
          class="ghost-btn"
          onclick={() => {
            const k = scanChoice;
            scanChoice = null;
            if (k === "album") void runMetaScanAll(true);
            else void runTrackScanAll(true);
          }}
        >
          Riscan tutto
        </button>
        <button
          type="button"
          class="primary-btn"
          onclick={() => {
            const k = scanChoice;
            scanChoice = null;
            if (k === "album") void runMetaScanAll(false);
            else void runTrackScanAll(false);
          }}
        >
          Solo mancanti
        </button>
        <button type="button" class="ghost-btn" onclick={() => (scanChoice = null)}>
          Annulla
        </button>
      </div>
    </div>
  </div>
{/if}
