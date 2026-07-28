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

  const DEST_KEY = "rekord-dl-output";

  let {
    seedUrl = "",
    seedMode = "single" as "single" | "playlist" | "releases",
  }: {
    seedUrl?: string;
    seedMode?: "single" | "playlist" | "releases";
  } = $props();

  let dlMode = $state<"classic" | "explore">("classic");
  let dlUrlMode = $state<"single" | "playlist" | "releases">("single");
  let dlUrl = $state("");
  let dlLog = $state("");
  let destPath = $state("");
  let dirs = $state<FsDirEntry[]>([]);
  let newFolder = $state("");
  let busy = $state(false);
  let err = $state<string | null>(null);
  let progress = $state<{ current: number; total: number } | null>(null);
  let downloadId = $state<string | null>(null);

  let exploreQ = $state("");
  let exploreResults = $state<ExploreResult[]>([]);
  let exploreBusy = $state(false);
  let releases = $state<ReleaseEntry[]>([]);
  let releasesTitle = $state("");
  let selectedReleases = $state<Set<string>>(new Set());

  $effect(() => {
    if (seedUrl) {
      dlUrl = seedUrl;
      dlUrlMode = seedMode;
      dlMode = "classic";
    }
  });

  onMount(() => {
    try {
      destPath = sessionStorage.getItem(DEST_KEY) || "";
    } catch {
      /* ignore */
    }
    void refreshDirs();
  });

  function commitDest(path: string) {
    destPath = path;
    try {
      sessionStorage.setItem(DEST_KEY, path);
    } catch {
      /* ignore */
    }
  }

  async function refreshDirs() {
    try {
      const list = await api.fsList(destPath);
      dirs = list.dirs;
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
    await refreshDirs();
  }

  async function createFolder() {
    const name = newFolder.trim();
    if (!name) return;
    busy = true;
    try {
      const r = await api.fsMkdir(destPath, name);
      newFolder = "";
      commitDest(r.relPath);
      await refreshDirs();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function appendLog(line: string) {
    dlLog = (dlLog ? `${dlLog}\n` : "") + line;
  }

  function kindForMode(): string {
    if (dlUrlMode === "single") return "download_single";
    if (dlUrlMode === "releases") return "download_releases";
    return "download_playlist";
  }

  function resolveOutputDir(titleHint = ""): string {
    const dest = destPath.trim();
    const segs = dest.split("/").filter(Boolean);
    if (dlUrlMode === "single") {
      if (segs.length < 2) {
        throw new Error("Per un brano singolo scegli una cartella Artista/Album.");
      }
      return dest;
    }
    if (segs.length === 1 && titleHint) {
      return `${dest}/${titleHint.replace(/[\\/]/g, "-").trim()}`;
    }
    return dest;
  }

  async function runDownload(url: string, kind: string, outputDir: string) {
    if (!url.trim()) throw new Error("URL mancante");
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
            appendLog(`… ${ev.progress.current}/${ev.progress.total}`);
          } else if (ev.type === "done") {
            if (ev.stdout) appendLog(ev.stdout.slice(-2000));
            if (ev.stderr) appendLog(ev.stderr.slice(-2000));
            appendLog(
              ev.ok
                ? "✓ Download completato — scansione libreria in corso."
                : ev.cancelled
                  ? "Download annullato."
                  : "✗ Download fallito.",
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
    try {
      const out = resolveOutputDir();
      await runDownload(dlUrl, kindForMode(), out);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }

  async function onCancel() {
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
    selectedReleases = new Set();
    try {
      const list = await api.youtubeReleasesList(item.url, false);
      releases = list.entries;
      releasesTitle = list.listTitle || item.title;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      exploreBusy = false;
    }
  }

  async function downloadExploreItem(item: ExploreResult) {
    err = null;
    try {
      const kind = item.type === "song" ? "download_single" : "download_playlist";
      const out =
        kind === "download_single"
          ? resolveOutputDir()
          : resolveOutputDir(item.title);
      await runDownload(item.url, kind === "download_single" ? kind : "download_ytmusic", out);
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
    const base = destPath.trim();
    if (!base) {
      err = "Scegli la cartella artista di destinazione.";
      return;
    }
    for (const r of picked) {
      try {
        await runDownload(r.url, "download_releases", base);
      } catch (e) {
        appendLog(`Errore su ${r.title}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async function loadReleasesFromUrl() {
    err = null;
    busy = true;
    try {
      const list = await api.youtubeReleasesList(dlUrl, false);
      releases = list.entries;
      releasesTitle = list.listTitle || "Uscite";
      selectedReleases = new Set();
      appendLog(`Trovate ${list.entries.length} uscite.`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const crumbs = $derived(destPath.split("/").filter(Boolean));
  const rootLabel = $derived(
    session.stats?.music_root?.split("/").pop() || "Musica",
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
              <button type="button" class="crumb" onclick={() => { commitDest(""); void refreshDirs(); }}>
                {rootLabel}
              </button>
              {#each crumbs as c, i}
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
              {/each}
            </nav>
          </div>
        </div>
      </div>
      <div class="tools-dl-dest__browser rk-scroll">
        {#if dirs.length}
          {#each dirs as d}
            <button
              type="button"
              class="tools-dl-dest__dir"
              onclick={() => void enterDir(d.relPath)}
            >
              <UiIcon name="album" />
              <span>{d.name}</span>
            </button>
          {/each}
        {:else}
          <p class="tools-dl-dest__empty">Nessuna sottocartella.</p>
        {/if}
      </div>
      <div class="tools-dl-dest__create">
        <input
          type="text"
          class="tools-dl-dest__newinput"
          placeholder="Nuova cartella…"
          bind:value={newFolder}
          disabled={busy}
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
    </div>
  </div>

  <div class="studio-panel">
    {#if dlMode === "explore"}
      <h4 class="studio-panel-title">Explora</h4>
      <p class="subtle sm studio-panel-gap">Ricerca YouTube Music → download nella cartella scelta.</p>
      <input
        type="search"
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
        {#each releases as r}
          <label class="check">
            <input
              type="checkbox"
              checked={selectedReleases.has(r.id)}
              onchange={(e) => {
                const next = new Set(selectedReleases);
                if (e.currentTarget.checked) next.add(r.id);
                else next.delete(r.id);
                selectedReleases = next;
              }}
            />
            {r.title}
            {#if r.trackCount != null}
              <span class="subtle sm">· {r.trackCount}</span>
            {/if}
          </label>
        {/each}
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
              onclick={() => (dlUrlMode = "single")}
            >
              Singolo
            </button>
            <button
              type="button"
              class="tools-dl-mode__btn"
              class:is-on={dlUrlMode === "playlist"}
              onclick={() => (dlUrlMode = "playlist")}
            >
              Album o Playlist
            </button>
            <button
              type="button"
              class="tools-dl-mode__btn"
              class:is-on={dlUrlMode === "releases"}
              onclick={() => (dlUrlMode = "releases")}
            >
              Uscite Artista
            </button>
          </div>
        </div>
      </div>
      <input
        type="url"
        placeholder="https://…"
        bind:value={dlUrl}
        disabled={busy}
        aria-label="URL da scaricare"
      />
      <div class="studio-inline-actions studio-inline-actions--spaced tools-dl-actions-row">
        <p class="tools-dl-disclaimer">
          Scarica solo contenuti di cui hai i diritti. Richiede yt-dlp sul server.
          {#if progress}
            · {progress.current}/{progress.total}
          {/if}
        </p>
        {#if dlUrlMode === "releases"}
          <button
            type="button"
            class="ghost-btn"
            disabled={busy || !dlUrl.trim()}
            onclick={() => void loadReleasesFromUrl()}
          >
            Elenca uscite
          </button>
          <button
            type="button"
            class="primary-btn"
            disabled={busy || !selectedReleases.size}
            onclick={() => void downloadSelectedReleases()}
          >
            Scarica selezionate
          </button>
        {:else}
          <button
            type="button"
            class="primary-btn"
            disabled={busy || !dlUrl.trim()}
            onclick={() => void onClassicDownload()}
          >
            {busy ? "Download…" : "Scarica e importa"}
          </button>
        {/if}
        {#if busy && downloadId}
          <button type="button" class="ghost-btn" onclick={() => void onCancel()}>
            Annulla
          </button>
        {/if}
      </div>
      {#if dlUrlMode === "releases" && releases.length}
        {#each releases as r}
          <label class="check">
            <input
              type="checkbox"
              checked={selectedReleases.has(r.id)}
              onchange={(e) => {
                const next = new Set(selectedReleases);
                if (e.currentTarget.checked) next.add(r.id);
                else next.delete(r.id);
                selectedReleases = next;
              }}
            />
            {r.title}
          </label>
        {/each}
      {/if}
    {/if}
  </div>

  {#if err}
    <p class="subtle sm warnline">{err}</p>
  {/if}

  <div class="studio-log">
    <label class="subtle sm" for="studio-dl-log">Log</label>
    <textarea id="studio-dl-log" class="log rk-scroll" rows="4" bind:value={dlLog}></textarea>
    <button type="button" class="linkbtn" onclick={() => (dlLog = "")}>Pulisci</button>
  </div>
</div>
