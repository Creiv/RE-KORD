<script lang="ts">
  import { onMount } from "svelte";
  import UiIcon from "../icons/UiIcon.svelte";
  import {
    api,
    type ExploreResult,
    type FsDirEntry,
    type ReleaseEntry,
  } from "../../lib/api";
  import { session } from "../../lib/session.svelte";
  import {
    buildStudioDownloadConfirm,
    isValidDownloadDestPath,
    normalizeDownloadDestPath,
    relPathLooksLikeAlbumFolderDest,
    resolveStudioDownloadOutputDir,
    studioDownloadKindForScope,
    type StudioDownloadScope,
  } from "../../lib/studioDownloadDest";
  import {
    detectStudioDlMode,
    looksLikeSupportedDownloadUrl,
    urlMatchesStudioDlMode,
    type DlVideoMode,
  } from "../../lib/youtubeUrl";
  import { partitionYoutubeReleaseEntries } from "../../lib/youtubeReleases";

  const DEST_KEY = "rekord-dl-output";
  const DEST_OK_KEY = "rekord-dl-ok";

  let {
    seedUrl = "",
    seedMode = "single" as DlVideoMode,
  }: {
    seedUrl?: string;
    seedMode?: DlVideoMode;
  } = $props();

  let dlMode = $state<"classic" | "explore">("classic");
  let dlUrlMode = $state<DlVideoMode>("single");
  let dlUrl = $state("");
  let dlLog = $state("");
  let destPath = $state("");
  let destPicked = $state(false);
  let dirs = $state<FsDirEntry[]>([]);
  let newFolder = $state("");
  let busy = $state(false);
  let err = $state<string | null>(null);
  let progress = $state<{ current: number; total: number } | null>(null);
  let batchProg = $state<{ current: number; total: number } | null>(null);
  let downloadId = $state<string | null>(null);
  let batchStop = $state(false);
  let lastDetectedUrl = $state("");

  let dirSearchOpen = $state(false);
  let dirQuery = $state("");
  let dirResults = $state<FsDirEntry[]>([]);
  let dirSearchBusy = $state(false);
  let dirSearchTimer: ReturnType<typeof setTimeout> | undefined;

  let exploreQ = $state("");
  let exploreResults = $state<ExploreResult[]>([]);
  let exploreBusy = $state(false);
  let releases = $state<ReleaseEntry[]>([]);
  let releasesTitle = $state("");
  let releasesUploader = $state("");
  let selectedReleases = $state<Set<string>>(new Set());
  let relQuery = $state("");
  let ytdlpReady = $state<boolean | null>(null);
  let cookiesOk = $state(false);

  $effect(() => {
    if (seedUrl) {
      dlUrl = seedUrl;
      dlUrlMode = seedMode;
      lastDetectedUrl = seedUrl.trim();
      dlMode = "classic";
    }
  });

  /** Auto-rileva tipo link solo quando cambia l’URL (non sovrascrive scelta manuale). */
  $effect(() => {
    const url = dlUrl.trim();
    if (url === lastDetectedUrl) return;
    lastDetectedUrl = url;
    const detected = detectStudioDlMode(url);
    if (detected) dlUrlMode = detected;
  });

  $effect(() => {
    dlUrl;
    dlUrlMode;
    releases = [];
    releasesTitle = "";
    releasesUploader = "";
    selectedReleases = new Set();
    relQuery = "";
  });

  onMount(() => {
    try {
      const saved = normalizeDownloadDestPath(sessionStorage.getItem(DEST_KEY) || "");
      const ok = sessionStorage.getItem(DEST_OK_KEY) === "1";
      if (saved && ok) {
        destPath = saved;
        destPicked = true;
      }
    } catch {
      /* ignore */
    }
    void refreshDirs();
    void api
      .downloadPreset()
      .then((p) => {
        ytdlpReady = !!p.found;
        cookiesOk = !!p.cookiesConfigured;
      })
      .catch(() => {
        ytdlpReady = null;
      });
  });

  function commitDest(path: string) {
    const normalized = normalizeDownloadDestPath(path);
    destPath = normalized;
    destPicked = Boolean(normalized);
    try {
      if (normalized) {
        sessionStorage.setItem(DEST_KEY, normalized);
        sessionStorage.setItem(DEST_OK_KEY, "1");
      } else {
        sessionStorage.removeItem(DEST_KEY);
        sessionStorage.removeItem(DEST_OK_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  async function refreshDirs() {
    try {
      const list = await api.fsList(destPath);
      dirs = list.dirs;
      if (isValidDownloadDestPath(list.path ?? destPath)) {
        commitDest(list.path ?? destPath);
      }
      err = null;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      dirs = [];
    }
  }

  async function goUp() {
    if (!destPath) return;
    const parts = destPath.split("/").filter(Boolean);
    parts.pop();
    commitDest(parts.join("/"));
    await refreshDirs();
  }

  async function enterDir(rel: string) {
    commitDest(rel);
    dirSearchOpen = false;
    dirQuery = "";
    dirResults = [];
    await refreshDirs();
  }

  const destSegs = $derived(destPath.split("/").filter(Boolean));
  const inAlbumFolder = $derived(relPathLooksLikeAlbumFolderDest(destPath));
  const mkdirBlocked = $derived(inAlbumFolder);
  const hasValidDownloadDest = $derived(
    destPicked && isValidDownloadDestPath(destPath),
  );
  const dlUrlValid = $derived(urlMatchesStudioDlMode(dlUrl, dlUrlMode));
  const urlPlaceholder = $derived(
    dlUrlMode === "single"
      ? "https://www.youtube.com/watch?v=…"
      : dlUrlMode === "playlist"
        ? "https://music.youtube.com/playlist?list=… o link album"
        : "https://music.youtube.com/browse/… o /channel/…/releases",
  );

  const filteredReleases = $derived.by(() => {
    const q = relQuery.trim().toLowerCase();
    if (!q) return releases;
    return releases.filter(
      (r) =>
        r.title.toLowerCase().includes(q) || r.url.toLowerCase().includes(q),
    );
  });
  const partitioned = $derived(
    partitionYoutubeReleaseEntries(
      filteredReleases.map((r) => ({
        ...r,
        trackCount: r.trackCount ?? null,
      })),
    ),
  );

  async function createFolder() {
    const name = newFolder.trim();
    if (!name || mkdirBlocked) return;
    busy = true;
    try {
      const r = await api.fsMkdir(destPath, name);
      newFolder = "";
      commitDest(r.relPath);
      await refreshDirs();
      appendLog(`Cartella creata: ${r.relPath}`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onDirSearchInput() {
    clearTimeout(dirSearchTimer);
    dirSearchTimer = setTimeout(() => void runDirSearch(), 280);
  }

  async function runDirSearch() {
    const q = dirQuery.trim();
    if (q.length < 2) {
      dirResults = [];
      return;
    }
    dirSearchBusy = true;
    try {
      const r = await api.fsSearchDirs(q);
      dirResults = r.results || [];
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      dirResults = [];
    } finally {
      dirSearchBusy = false;
    }
  }

  function appendLog(line: string) {
    dlLog = (dlLog ? `${dlLog}\n` : "") + line;
  }

  async function confirmDownload(message: string): Promise<boolean> {
    return confirm(message);
  }

  async function runDownload(url: string, kind: string, outputDir: string) {
    if (!url.trim()) throw new Error("URL mancante");
    if (!looksLikeSupportedDownloadUrl(url)) {
      throw new Error("URL non supportato (YouTube / SoundCloud / Bandcamp).");
    }
    const id = crypto.randomUUID();
    downloadId = id;
    busy = true;
    progress = null;
    appendLog(`→ Avvio download (${kind}) → ${outputDir || "(root)"}`);
    try {
      await api.startDownload(
        { url: url.trim(), downloadId: id, downloadKind: kind, outputDir },
        (ev) => {
          if (ev.type === "progress" && ev.progress) {
            progress = ev.progress;
          } else if (ev.type === "done") {
            if (ev.stdout) appendLog(ev.stdout.slice(-2000));
            if (ev.stderr) appendLog(ev.stderr.slice(-2000));
            const nOk = ev.downloadedItems?.length ?? 0;
            const nSkip = ev.skippedItems?.length ?? 0;
            const nFail = ev.failedItems?.length ?? 0;
            if (nOk || nSkip || nFail) {
              appendLog(`Riepilogo: ${nOk} scaricati, ${nSkip} già presenti, ${nFail} errori.`);
            }
            if (ev.failedItems?.length) {
              for (const f of ev.failedItems.slice(0, 8)) {
                appendLog(`  · ${f.label || f.reason}`);
              }
            }
            appendLog(
              ev.ok
                ? "✓ Download completato — scansione libreria in corso."
                : ev.cancelled
                  ? "Download annullato."
                  : nOk === 0
                    ? "✗ Download fallito — nessun file scritto su disco (controlla formato/yt-dlp)."
                    : "✗ Download fallito (parziale).",
            );
          } else if (ev.type === "started") {
            appendLog("yt-dlp avviato…");
          }
        },
      );
      await session.refreshAll();
    } finally {
      busy = false;
      downloadId = null;
      progress = null;
    }
  }

  async function onClassicDownload() {
    err = null;
    if (!hasValidDownloadDest) {
      err = "Scegli prima la cartella di salvataggio.";
      return;
    }
    if (!dlUrl.trim()) {
      err = "Inserisci un URL.";
      return;
    }
    if (!urlMatchesStudioDlMode(dlUrl, dlUrlMode)) {
      err =
        "L’URL non corrisponde alla modalità selezionata (Singolo / Album o Playlist / Uscite Artista).";
      appendLog("URL non compatibile con la modalità attuale.");
      return;
    }
    if (dlUrlMode === "releases") {
      err = "Per le uscite artista usa «Elenca uscite» e seleziona gli album.";
      return;
    }
    try {
      const scope: StudioDownloadScope =
        dlUrlMode === "playlist" ? "playlist" : "single";
      if (scope === "single" && !inAlbumFolder) {
        err = "Per un brano singolo scegli una cartella Artista/Album.";
        return;
      }
      let trackCount: number | null = null;
      if (scope === "playlist") {
        try {
          const r = await api.downloadFlatCount(dlUrl.trim());
          trackCount = r.count;
          appendLog(`Playlist: ${trackCount} brani (conteggio flat).`);
        } catch (e) {
          err = `Conteggio playlist fallito: ${e instanceof Error ? e.message : e}`;
          return;
        }
      }
      const confirm = buildStudioDownloadConfirm({
        dlPath: destPath,
        scope,
        trackCount,
      });
      if (!(await confirmDownload(confirm.message))) return;
      const out = resolveStudioDownloadOutputDir(destPath, scope);
      await runDownload(dlUrl, studioDownloadKindForScope(scope), out);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }

  async function onCancel() {
    batchStop = true;
    if (!downloadId) return;
    try {
      await api.downloadCancel(downloadId);
      appendLog("Richiesta di annullamento inviata.");
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }

  let exploreTimer: ReturnType<typeof setTimeout> | undefined;
  function onExploreInput() {
    clearTimeout(exploreTimer);
    exploreTimer = setTimeout(() => void runExplore(), 420);
  }

  async function runExplore() {
    const q = exploreQ.trim();
    if (q.length < 2) {
      exploreResults = [];
      return;
    }
    exploreBusy = true;
    try {
      const r = await api.youtubeExploreSearch(q);
      exploreResults = r.results;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      exploreBusy = false;
    }
  }

  async function openArtistReleases(item: ExploreResult) {
    exploreBusy = true;
    releases = [];
    releasesTitle = item.title;
    releasesUploader = "";
    selectedReleases = new Set();
    try {
      const list = await api.youtubeReleasesList(item.url, false);
      releases = list.entries;
      releasesTitle = list.listTitle || item.title;
      releasesUploader = list.uploader || "";
      appendLog(`Trovate ${list.entries.length} uscite per «${releasesTitle}».`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      exploreBusy = false;
    }
  }

  async function downloadExploreItem(item: ExploreResult) {
    err = null;
    if (!hasValidDownloadDest) {
      err = "Scegli la cartella di destinazione.";
      return;
    }
    try {
      const scope: StudioDownloadScope =
        item.type === "song" ? "single" : "playlist";
      if (scope === "single" && !inAlbumFolder) {
        err = "Per un brano singolo scegli una cartella Artista/Album.";
        return;
      }
      let trackCount: number | null = null;
      if (scope === "playlist") {
        try {
          trackCount = (await api.downloadFlatCount(item.url)).count;
        } catch (e) {
          err = `Conteggio fallito: ${e instanceof Error ? e.message : e}`;
          return;
        }
      }
      const confirm = buildStudioDownloadConfirm({
        dlPath: destPath,
        scope,
        releaseTitle: scope === "playlist" ? item.title : undefined,
        trackCount,
        preamble: `Brano/album: ${item.title}`,
      });
      if (!(await confirmDownload(confirm.message))) return;
      const out = resolveStudioDownloadOutputDir(
        destPath,
        scope,
        scope === "playlist" ? item.title : undefined,
      );
      await runDownload(item.url, studioDownloadKindForScope(scope), out);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }

  async function downloadSelectedReleases() {
    err = null;
    const picked = releases.filter((r) => selectedReleases.has(r.id));
    if (!picked.length) {
      err = "Seleziona almeno un’uscita.";
      return;
    }
    const base = normalizeDownloadDestPath(destPath);
    if (!base || !hasValidDownloadDest) {
      err = "Scegli la cartella artista di destinazione.";
      return;
    }
    if (inAlbumFolder) {
      err = "Per più album scegli la cartella artista (non Artista/Album).";
      return;
    }
    const n = picked.length;
    const usciteLabel = n === 1 ? "1 uscita" : `${n} uscite`;
    if (
      !(await confirmDownload(
        `Scaricare ${usciteLabel} in «${base}»?\nOgni album andrà in una sottocartella.`,
      ))
    ) {
      return;
    }
    batchStop = false;
    batchProg = { current: 0, total: picked.length };
    for (let i = 0; i < picked.length; i++) {
      if (batchStop) {
        appendLog("Batch interrotto.");
        break;
      }
      const r = picked[i]!;
      batchProg = { current: i + 1, total: picked.length };
      try {
        const out = resolveStudioDownloadOutputDir(base, "playlist", r.title);
        await runDownload(r.url, "download_releases", out);
      } catch (e) {
        appendLog(`Errore su ${r.title}: ${e instanceof Error ? e.message : e}`);
      }
    }
    batchProg = null;
  }

  async function loadReleasesFromUrl() {
    err = null;
    if (!dlUrl.trim()) return;
    if (!urlMatchesStudioDlMode(dlUrl, "releases")) {
      err =
        "URL non valido per le uscite: usa music.youtube.com/browse/… o …/releases.";
      return;
    }
    if (!hasValidDownloadDest) {
      err = "Scegli prima la cartella di salvataggio.";
      return;
    }
    busy = true;
    releases = [];
    selectedReleases = new Set();
    try {
      const list = await api.youtubeReleasesList(dlUrl, false);
      releases = list.entries;
      releasesTitle = list.listTitle || "Uscite";
      releasesUploader = list.uploader || "";
      appendLog(
        `Trovate ${list.entries.length} uscite` +
          (releasesUploader ? ` — ${releasesUploader}` : "") +
          ".",
      );
      if (!list.entries.length) {
        err = "Nessuna uscita trovata su questa pagina.";
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function setModeManual(mode: DlVideoMode) {
    dlUrlMode = mode;
  }

  function toggleRel(id: string) {
    const next = new Set(selectedReleases);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedReleases = next;
  }

  const crumbs = $derived(destPath.split("/").filter(Boolean));
  const rootLabel = $derived(
    session.stats?.music_root?.split("/").pop() || "Musica",
  );
  const showProgress = $derived(!!(busy && (progress || batchProg)));
  const progressPct = $derived(
    progress && progress.total > 0
      ? Math.max(2, Math.min(100, (progress.current / progress.total) * 100))
      : 0,
  );
  const batchPct = $derived(
    batchProg && batchProg.total > 0
      ? Math.max(2, Math.min(100, (batchProg.current / batchProg.total) * 100))
      : 0,
  );
</script>

<div class="studio-pane tools-download" role="region" aria-label="Download">
  <div class="studio-panel tools-dl-dest">
    <div class="tools-dl-dest__head">
      <div class="tools-dl-dest__head-text">
        <h4 class="studio-panel-title">Cartella di salvataggio (sotto Musica)</h4>
        <p class="subtle sm tools-dl-dest__lead">
          Scegli dove salvare i file scaricati prima dell’import in libreria.
        </p>
      </div>
      <div
        class="tools-dl-studio-switch tools-dl-dest__mode-switch"
        role="group"
        aria-label="Modalità Download"
      >
        <span class="tools-dl-studio-switch__label" class:is-active={dlMode === "classic"}>
          Classico
        </span>
        <button
          type="button"
          role="switch"
          class="tools-dl-studio-switch__track"
          aria-checked={dlMode === "explore"}
          aria-label="Modalità Download"
          onclick={() => (dlMode = dlMode === "classic" ? "explore" : "classic")}
        >
          <span class="tools-dl-studio-switch__thumb" aria-hidden="true"></span>
        </button>
        <span class="tools-dl-studio-switch__label" class:is-active={dlMode === "explore"}>
          Explora
        </span>
      </div>
    </div>
    <div class="tools-dl-dest__shell">
      <div class="tools-dl-dest__pathheader">
        <p class="tools-dl-dest__label" id="tools-dl-dest-where">Cartella attuale</p>
        <div class="tools-dl-dest__pathrow">
          <div class="tools-dl-dest__pathbar">
            <button
              type="button"
              class="tools-dl-dest__up-icon"
              disabled={!destPath || busy}
              title="Cartella superiore"
              aria-label="Cartella superiore"
              onclick={() => void goUp()}
            >
              <UiIcon name="chevronLeft" />
            </button>
            <nav class="breadcrumbs tools-dl-dest__crumbs" aria-labelledby="tools-dl-dest-where">
              <button
                type="button"
                class="crumb"
                onclick={() => {
                  commitDest("");
                  void refreshDirs();
                }}
              >
                {rootLabel}
              </button>
              {#each crumbs as c, i}
                <span class="tools-dl-dest__bc">
                  <span class="tools-dl-dest__bc-sep" aria-hidden="true">/</span>
                  <button
                    type="button"
                    class="crumb"
                    onclick={() => {
                      commitDest(crumbs.slice(0, i + 1).join("/"));
                      void refreshDirs();
                    }}
                  >
                    {c}
                  </button>
                </span>
              {/each}
            </nav>
          </div>
          <div class="tools-dl-dest__search" class:is-open={dirSearchOpen}>
            <button
              type="button"
              class="tools-dl-dest__search-toggle"
              aria-label="Cerca cartella"
              aria-pressed={dirSearchOpen}
              onclick={() => {
                dirSearchOpen = !dirSearchOpen;
                if (!dirSearchOpen) {
                  dirQuery = "";
                  dirResults = [];
                }
              }}
            >
              <UiIcon name="search" class="tools-dl-dest__search-toggle-ic" />
            </button>
            <div class="tools-dl-dest__search-field">
              <input
                type="search"
                class="ghost-input tools-dl-dest__search-input"
                placeholder="Cerca cartella…"
                bind:value={dirQuery}
                oninput={onDirSearchInput}
                disabled={busy}
              />
            </div>
            {#if dirSearchOpen && (dirResults.length || dirSearchBusy || dirQuery.trim().length >= 2)}
              <div class="tools-dl-dest__search-results rk-scroll">
                {#if dirSearchBusy}
                  <p class="subtle sm">Cerco…</p>
                {:else if dirResults.length}
                  <ul class="tools-dl-dest__dirlist">
                    {#each dirResults as d}
                      <li>
                        <button
                          type="button"
                          class="tools-dl-dest__dirbtn"
                          onclick={() => void enterDir(d.relPath)}
                        >
                          <UiIcon name="album" class="tools-dl-dest__dir-ic" />
                          <span class="tools-dl-dest__dir-name">{d.relPath}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="subtle sm">Nessuna cartella.</p>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </div>

      <div class="tools-dl-dest__browser" role="group" aria-label="Sottocartelle">
        {#if dirs.length === 0}
          <p class="subtle sm tools-dl-dest__empty">Nessuna sottocartella.</p>
        {/if}
        <ul class="tools-dl-dest__dirlist">
          {#each dirs as d}
            <li>
              <button
                type="button"
                class="tools-dl-dest__dirbtn"
                onclick={() => void enterDir(d.relPath)}
              >
                <UiIcon name="album" class="tools-dl-dest__dir-ic" />
                <span class="tools-dl-dest__dir-name">{d.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>

      <div class="tools-dl-dest__create">
        {#if mkdirBlocked}
          <p class="subtle sm tools-dl-dest__mkdir-blocked">
            Sei già in una cartella album: non puoi creare altre sottocartelle qui.
          </p>
        {:else}
          <p class="tools-dl-dest__label tools-dl-dest__label--inline">Nuova sottocartella</p>
          <div class="tools-dl-dest__newrow">
            <input
              type="text"
              class="ghost-input tools-dl-dest__newinput"
              placeholder="Nuova cartella…"
              bind:value={newFolder}
              disabled={busy}
              onkeydown={(e) => {
                if (e.key === "Enter" && newFolder.trim()) {
                  e.preventDefault();
                  void createFolder();
                }
              }}
            />
            <button
              type="button"
              class="ghost-btn ghost-btn--sm"
              disabled={busy || !newFolder.trim()}
              onclick={() => void createFolder()}
            >
              Crea qui
            </button>
          </div>
        {/if}
      </div>

      {#if hasValidDownloadDest}
        <div class="tools-dl-dest__picked" role="status">
          Destinazione: <code>{destPath}</code>
          {#if inAlbumFolder}
            · cartella album
          {:else if destSegs.length === 1}
            · cartella artista
          {/if}
        </div>
      {:else}
        <p class="subtle sm warnline tools-dl-dest__warn">
          Seleziona una cartella (entra in una sottocartella) prima di scaricare.
        </p>
      {/if}
    </div>
  </div>

  <div class="studio-panel">
    {#if dlMode === "explore"}
      <h4 class="studio-panel-title">Explora</h4>
      <p class="subtle sm studio-panel-gap">Ricerca YouTube Music → download nella cartella scelta.</p>
      <input
        type="search"
        class="ghost-input"
        placeholder="Cerca artista, album o brano…"
        bind:value={exploreQ}
        oninput={onExploreInput}
        disabled={busy}
      />
      {#if exploreBusy}
        <p class="subtle sm">Ricerca…</p>
      {/if}
      <div class="library-overview-cols studio-panel-gap">
        {#each exploreResults as item}
          <div class="studio-catalog-list-tile">
            <div class="studio-catalog-list-tile__main">
              <div>
                <div class="library-list-tile__title">{item.title}</div>
                <div class="library-list-tile__meta">
                  {item.type} · {item.subtitle}
                </div>
              </div>
            </div>
            <div class="studio-catalog-list-tile__actions">
              {#if item.type === "artist"}
                <button
                  type="button"
                  class="ghost-btn"
                  disabled={busy || exploreBusy}
                  onclick={() => void openArtistReleases(item)}
                >
                  Uscite
                </button>
              {/if}
              <button
                type="button"
                class="primary-btn"
                disabled={busy}
                onclick={() => void downloadExploreItem(item)}
              >
                Scarica
              </button>
            </div>
          </div>
        {/each}
      </div>
      {#if releases.length}
        <h4 class="studio-panel-title">{releasesTitle}</h4>
        <div class="studio-action-row">
          <button
            type="button"
            class="primary-btn"
            disabled={busy || !selectedReleases.size}
            onclick={() => void downloadSelectedReleases()}
          >
            Scarica selezionate ({selectedReleases.size})
          </button>
        </div>
        <ul class="tools-dl-releases__list tools-dl-releases__list--grid">
          {#each releases as r}
            <li class="tools-dl-releases__row">
              <label class="tools-dl-releases__check">
                <input
                  type="checkbox"
                  checked={selectedReleases.has(r.id)}
                  onchange={() => toggleRel(r.id)}
                />
                <span class="tools-dl-releases__title" title={r.url}>{r.title}</span>
                {#if r.trackCount != null}
                  <span class="tools-dl-releases__trackcount">{r.trackCount}</span>
                {/if}
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <h4 class="studio-panel-title">Link</h4>
      <div class="tools-dl-modes">
        <div class="tools-dl-mode">
          <div class="tools-dl-mode__seg" role="group" aria-label="Tipo download">
            <button
              type="button"
              class="tools-dl-mode__btn"
              class:is-on={dlUrlMode === "single"}
              aria-pressed={dlUrlMode === "single"}
              onclick={() => setModeManual("single")}
            >
              Singolo
            </button>
            <button
              type="button"
              class="tools-dl-mode__btn"
              class:is-on={dlUrlMode === "playlist"}
              aria-pressed={dlUrlMode === "playlist"}
              onclick={() => setModeManual("playlist")}
            >
              Album o Playlist
            </button>
            <button
              type="button"
              class="tools-dl-mode__btn"
              class:is-on={dlUrlMode === "releases"}
              aria-pressed={dlUrlMode === "releases"}
              onclick={() => setModeManual("releases")}
            >
              Uscite Artista
            </button>
          </div>
          <span class="tools-dl-mode__help-wrap">
            <button
              type="button"
              class="tools-dl-mode__help"
              aria-label="Guida modalità link"
            >
              ?
            </button>
            <span class="tools-dl-mode__tip" role="tooltip">
              Singolo: watch/shorts senza list=.
              Album/Playlist: /playlist o list=.
              Uscite Artista: music.youtube.com/browse/… o tab /releases del canale.
              Incollando un URL la modalità si aggiorna automaticamente.
            </span>
          </span>
        </div>
      </div>
      <input
        type="url"
        class="ghost-input"
        placeholder={urlPlaceholder}
        bind:value={dlUrl}
        disabled={busy}
        aria-label="URL da scaricare"
        aria-invalid={dlUrl.trim() !== "" && !dlUrlValid}
      />
      {#if dlUrl.trim() && !dlUrlValid}
        <p class="subtle sm warnline">
          URL non compatibile con «{dlUrlMode === "single"
            ? "Singolo"
            : dlUrlMode === "playlist"
              ? "Album o Playlist"
              : "Uscite Artista"}».
        </p>
      {/if}

      {#if dlUrlMode === "releases"}
        <div class="tools-dl-releases">
          {#if releases.length}
            <div class="tools-dl-releases__picks tools-dl-releases__picks--full">
              <p class="subtle sm">
                {releasesTitle}{releasesUploader && releasesUploader !== releasesTitle
                  ? ` — ${releasesUploader}`
                  : ""}
              </p>
              <div class="tools-dl-releases__toolbar">
                {#if releases.length > 1}
                  <input
                    type="search"
                    class="ghost-input"
                    bind:value={relQuery}
                    placeholder="Filtra uscite…"
                    aria-label="Filtra uscite"
                  />
                {/if}
                <button
                  type="button"
                  class="ghost-btn ghost-btn--sm"
                  onclick={() => {
                    selectedReleases = new Set(filteredReleases.map((e) => e.id));
                  }}
                >
                  Seleziona tutte
                </button>
                <button
                  type="button"
                  class="ghost-btn ghost-btn--sm"
                  onclick={() => (selectedReleases = new Set())}
                >
                  Nessuna
                </button>
              </div>
              <div class="tools-dl-releases__sections">
                {#if partitioned.albums.length}
                  <section class="tools-dl-releases__section" aria-label="Album">
                    <h4 class="tools-dl-releases__section-title">
                      Album
                      <span class="tools-dl-releases__section-count"
                        >{partitioned.albums.length}</span
                      >
                    </h4>
                    <ul class="tools-dl-releases__list tools-dl-releases__list--grid">
                      {#each partitioned.albums as r}
                        <li class="tools-dl-releases__row">
                          <label class="tools-dl-releases__check">
                            <input
                              type="checkbox"
                              checked={selectedReleases.has(r.id)}
                              onchange={() => toggleRel(r.id)}
                            />
                            <span class="tools-dl-releases__title" title={r.url}
                              >{r.title}</span
                            >
                            <span class="tools-dl-releases__trackcount">
                              {r.trackCount != null ? r.trackCount : "—"}
                            </span>
                          </label>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/if}
                {#if partitioned.songs.length}
                  <section class="tools-dl-releases__section" aria-label="Singoli">
                    <h4 class="tools-dl-releases__section-title">
                      Singoli
                      <span class="tools-dl-releases__section-count"
                        >{partitioned.songs.length}</span
                      >
                    </h4>
                    <ul class="tools-dl-releases__list tools-dl-releases__list--grid">
                      {#each partitioned.songs as r}
                        <li class="tools-dl-releases__row">
                          <label class="tools-dl-releases__check">
                            <input
                              type="checkbox"
                              checked={selectedReleases.has(r.id)}
                              onchange={() => toggleRel(r.id)}
                            />
                            <span class="tools-dl-releases__title" title={r.url}
                              >{r.title}</span
                            >
                            <span class="tools-dl-releases__trackcount">
                              {r.trackCount != null ? r.trackCount : "—"}
                            </span>
                          </label>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/if}
              </div>
            </div>
          {/if}
          <div class="studio-inline-actions studio-inline-actions--spaced tools-dl-actions-row">
            <p class="tools-dl-disclaimer">
              Scarica solo contenuti di cui hai i diritti. Richiede yt-dlp sul server.
              {#if ytdlpReady === true}
                · yt-dlp ok{#if cookiesOk} · cookie{/if}
              {:else if ytdlpReady === false}
                · yt-dlp non trovato
              {/if}
            </p>
            {#if !releases.length}
              <button
                type="button"
                class="primary-btn"
                disabled={busy || !dlUrl.trim() || !dlUrlValid || !hasValidDownloadDest}
                onclick={() => void loadReleasesFromUrl()}
              >
                {busy ? "Carico…" : "Elenca uscite"}
              </button>
            {:else}
              <button
                type="button"
                class="ghost-btn"
                disabled={busy || !dlUrl.trim() || !dlUrlValid}
                onclick={() => void loadReleasesFromUrl()}
              >
                Ricarica elenco
              </button>
              <button
                type="button"
                class="primary-btn"
                disabled={busy || !selectedReleases.size || inAlbumFolder}
                title={inAlbumFolder
                  ? "Scegli la cartella artista (non album)"
                  : undefined}
                onclick={() => void downloadSelectedReleases()}
              >
                Scarica selezionate ({selectedReleases.size})
              </button>
            {/if}
            {#if busy && downloadId}
              <button type="button" class="ghost-btn" onclick={() => void onCancel()}>
                Annulla
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="studio-inline-actions studio-inline-actions--spaced tools-dl-actions-row">
          <p class="tools-dl-disclaimer">
            Scarica solo contenuti di cui hai i diritti. Richiede yt-dlp sul server.
            {#if ytdlpReady === true}
              · yt-dlp ok{#if cookiesOk} · cookie{/if}
            {:else if ytdlpReady === false}
              · yt-dlp non trovato
            {/if}
          </p>
          <button
            type="button"
            class="primary-btn"
            disabled={busy || !dlUrl.trim() || !dlUrlValid || !hasValidDownloadDest}
            onclick={() => void onClassicDownload()}
          >
            {busy ? "Download…" : "Scarica e importa"}
          </button>
          {#if busy && downloadId}
            <button type="button" class="ghost-btn" onclick={() => void onCancel()}>
              Annulla
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  {#if showProgress}
    <div class="dl-progress-wrap" class:dl-progress-wrap--dual={!!batchProg && !!progress}>
      <div class="dl-progress-stop-row">
        <button type="button" class="ghost-btn ghost-btn--sm" onclick={() => void onCancel()}>
          Stop
        </button>
      </div>
      {#if batchProg && batchProg.total > 0}
        <div class="dl-progress-block">
          <div class="dl-progress-top">
            <span>Album / uscite</span>
            <span>{batchProg.current}/{batchProg.total}</span>
          </div>
          <div class="dl-progress-rail">
            <div class="dl-progress-fill" style="width: {batchPct}%"></div>
          </div>
        </div>
      {/if}
      {#if progress && progress.total > 0}
        <div class="dl-progress-block">
          <div class="dl-progress-top">
            <strong>Progresso</strong>
            <span>{progress.current}/{progress.total}</span>
          </div>
          <div class="dl-progress-rail">
            <div class="dl-progress-fill" style="width: {progressPct}%"></div>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if err}
    <p class="subtle sm warnline">{err}</p>
  {/if}

  <div class="studio-log">
    <label class="subtle sm" for="studio-dl-log">Log</label>
    <textarea
      id="studio-dl-log"
      class="rk-textarea log rk-scroll"
      rows="4"
      bind:value={dlLog}
    ></textarea>
    <button type="button" class="linkbtn" onclick={() => (dlLog = "")}>Pulisci</button>
  </div>
</div>
