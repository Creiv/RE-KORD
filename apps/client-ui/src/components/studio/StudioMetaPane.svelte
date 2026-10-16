<script lang="ts" module>
  /**
   * Bulk runs in flight, shared by every instance: leaving Studio and coming
   * back mounts a fresh pane while the old loop may still be finishing its
   * current request — the new one must not start a second copy alongside.
   */
  const runningKinds = new Set<string>();

  export type Progress = { current: number; total: number };
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Button, Modal, Segmented } from "@rekord/ui";
  import UiIcon from "../icons/UiIcon.svelte";
  import { api, type DiscogsCandidate, type Track } from "../../lib/api";
  import { confirmDialog } from "../../lib/confirm.svelte";
  import { fmtNumber, i18n, t, tp } from "../../lib/i18n.svelte";
  import { session } from "../../lib/session.svelte";
  import { trackHasFileMeta } from "../../lib/trackMoods";
  import { studioAccess } from "../../lib/studio/access.svelte";
  import { studioFocus, takeStudioAlbum } from "../../lib/studio/focus.svelte";
  import { studioCodeText, studioErrorCode, studioErrorText } from "../../lib/studio/errors";
  import StudioAccessNotice from "./StudioAccessNotice.svelte";
  import StudioEntityInfoCard from "./StudioEntityInfoCard.svelte";
  import StudioLog, { type StudioLogEntry, type StudioLogKind } from "./StudioLog.svelte";

  type RunKind = "meta" | "track" | "prune";
  type TitleChange = { album: string; fileName: string; from: string; to: string };

  /** Pause between per-track lookups: the providers rate-limit. */
  const TRACK_LOOKUP_GAP_MS = 200;
  const TRACK_PAGE = 1000;
  const LOG_MAX = 400;
  /** Sanitize preview rows rendered at once (the rest is counted). */
  const SANITIZE_SHOWN = 300;

  let metaArtistId = $state<number | null>(null);
  let metaAlbumId = $state<number | null>(null);
  let logEntries = $state<StudioLogEntry[]>([]);
  let logSeq = 0;
  let busy = $state(false);
  let err = $state<string | null>(null);
  let candidates = $state<DiscogsCandidate[]>([]);
  let discogsOpen = $state(false);

  let scanChoice = $state<null | "album" | "track">(null);
  let metaScanProg = $state<Progress | null>(null);
  let trackScanProg = $state<Progress | null>(null);
  /** Paging the track list before a track scan (can be tens of thousands). */
  let trackListProg = $state<Progress | null>(null);
  let pruneProg = $state<Progress | null>(null);
  let titleSanBusy = $state(false);
  let discogsConfigured = $state(true);
  /** Last sanitize run, shown as a sorted table instead of log lines. */
  let sanitize = $state<{
    scope: "album" | "all";
    dryRun: boolean;
    folder: string;
    changes: TitleChange[];
    /** Titles the user edited by hand: never rewritten. */
    skippedEdited: number;
  } | null>(null);
  let optionalTab = $state<"einfo" | "titles">("einfo");

  /** One controller per bulk run; null when that run is idle. */
  let runs = $state<Record<RunKind, AbortController | null>>({
    meta: null,
    track: null,
    prune: null,
  });
  /** Stop pressed, waiting for the in-flight request to come back. */
  let stopping = $state<Record<RunKind, boolean>>({ meta: false, track: false, prune: false });
  let destroyed = false;

  const metaAllBusy = $derived(runs.meta != null);
  const trackAllBusy = $derived(runs.track != null);
  const pruneBusy = $derived(runs.prune != null);
  const canWrite = $derived(studioAccess.canWrite);
  const writeTitle = $derived(studioAccess.reason ?? undefined);

  const artistsSorted = $derived(
    session.artists.slice().sort((a, b) => a.name.localeCompare(b.name, i18n.sortLocale)),
  );
  const metaArtist = $derived(
    metaArtistId != null ? (session.artists.find((a) => a.id === metaArtistId) ?? null) : null,
  );
  const metaAlbums = $derived(
    metaArtist
      ? session.allAlbums
          .filter(
            (a) =>
              !a.loose &&
              (a.artist_id === metaArtist.id ||
                (a.artist_id == null && a.artist_name === metaArtist.name)),
          )
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, i18n.sortLocale, { numeric: true }))
      : [],
  );
  const selectedAlbum = $derived(
    metaAlbumId != null ? metaAlbums.find((a) => a.id === metaAlbumId) : null,
  );
  const studioBusy = $derived(
    busy || metaAllBusy || trackAllBusy || pruneBusy || titleSanBusy,
  );

  /** Opened from the dashboard's "Da sistemare" list for one album. */
  const focusRequested = studioFocus.pane === "meta";
  let pendingAlbumId = $state<number | null>(null);

  onMount(() => {
    studioAccess.ensure();
    void api
      .config()
      .then((c) => {
        discogsConfigured = !!c.discogsConfigured;
      })
      .catch(() => {});
    if (!focusRequested) fillFromPlayback();
    return () => {
      destroyed = true;
      for (const c of Object.values(runs)) c?.abort();
    };
  });

  $effect(() => {
    if (studioFocus.pane === "meta" && studioFocus.albumId != null) {
      pendingAlbumId = untrack(() => takeStudioAlbum("meta"));
    }
  });

  // Artists and albums may still be loading when the pane opens.
  $effect(() => {
    const id = pendingAlbumId;
    if (id == null) return;
    const al = session.allAlbums.find((a) => a.id === id);
    if (!al) return;
    const artist =
      (al.artist_id != null ? session.artists.find((a) => a.id === al.artist_id) : null) ??
      session.artists.find((a) => a.name === al.artist_name);
    if (!artist) return;
    untrack(() => {
      metaArtistId = artist.id;
      metaAlbumId = al.id;
      pendingAlbumId = null;
    });
  });

  function appendLog(kind: StudioLogKind, line: string) {
    if (destroyed) return;
    const lines = line.split("\n").filter((l) => l.trim());
    const next = logEntries.concat(lines.map((text) => ({ id: ++logSeq, kind, text })));
    logEntries = next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
  }

  function fail(e: unknown, key = "ui.studioMeta.log.error"): string {
    const msg = studioErrorText(e);
    err = msg;
    appendLog("error", t(key, { error: msg }));
    return msg;
  }

  /** Claim a bulk run; null when one of that kind is already going. */
  function startRun(kind: RunKind): AbortSignal | null {
    if (runningKinds.has(kind) || runs[kind]) {
      appendLog("warn", t("ui.studioMeta.alreadyRunning"));
      return null;
    }
    runningKinds.add(kind);
    const ctrl = new AbortController();
    runs = { ...runs, [kind]: ctrl };
    return ctrl.signal;
  }

  function endRun(kind: RunKind) {
    runningKinds.delete(kind);
    if (destroyed) return;
    runs = { ...runs, [kind]: null };
    stopping = { ...stopping, [kind]: false };
  }

  function stopRun(kind: RunKind) {
    const ctrl = runs[kind];
    if (!ctrl) return;
    stopping = { ...stopping, [kind]: true };
    ctrl.abort();
  }

  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const id = setTimeout(done, ms);
      function done() {
        clearTimeout(id);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  function fillFromPlayback() {
    const cur = session.current;
    if (!cur) return;
    const byId = cur.artist_id != null ? session.artists.find((a) => a.id === cur.artist_id) : null;
    const artist = byId ?? session.artists.find((a) => a.name === cur.artist_name) ?? null;
    metaArtistId = artist?.id ?? null;
    metaAlbumId = cur.album_id;
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
            appendLog("info", tp("ui.studioMeta.log.discogsCandidates", candidates.length));
            discogsOpen = true;
            busy = false;
            return;
          }
          appendLog("info", t("ui.studioMeta.log.discogsNone"));
        } catch (e) {
          appendLog("warn", t("ui.studioMeta.log.discogsUnavailable", { error: studioErrorText(e) }));
        }
      }
      const r = (await api.albumInfoFetch(selectedAlbum.folder_key, artist, album)) as AlbumFetchResult;
      const source = String((r.meta as { source?: string })?.source || "");
      appendLog(
        "ok",
        source
          ? t("ui.studioMeta.log.albumFetchOk", { source })
          : t("ui.studioMeta.log.albumFetchOkBare"),
      );
      reportAlbumFetch(r);
      // Albums (name, cover) and tracks (titles, genre) → views and player bar.
      await Promise.all([session.loadAllAlbums(), session.syncCatalogDelta()]);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  /** Extra fields of `album-info/fetch` on current hubs. */
  type AlbumFetchResult = {
    meta: Record<string, unknown>;
    titleApplied?: boolean;
    confidence?: number | null;
    expectedTracks?: number | null;
    localTrackCount?: number | null;
    skipped?: Array<{ field?: string; reason?: string }>;
    errors?: Array<{ source?: string; code?: string; message?: string }>;
  };

  function sourceErrorsLine(errors: Array<{ source?: string; code?: string; message?: string }> | undefined) {
    if (!Array.isArray(errors) || !errors.length) return;
    appendLog(
      "detail",
      t("ui.studioMeta.log.sourceErrors", {
        sources: errors
          .map((e) => `${e.source ?? "?"}: ${studioCodeText(e.code ?? null, e.message ?? null)}`)
          .join(" · "),
      }),
    );
  }

  function reportAlbumFetch(r: AlbumFetchResult) {
    if (typeof r.confidence === "number") {
      appendLog("detail", t("ui.studioMeta.log.confidence", { n: Math.round(r.confidence * (r.confidence <= 1 ? 100 : 1)) }));
    }
    if (
      typeof r.expectedTracks === "number" &&
      typeof r.localTrackCount === "number" &&
      r.expectedTracks !== r.localTrackCount
    ) {
      appendLog(
        "warn",
        t("ui.studioMeta.log.trackCountMismatch", {
          expected: r.expectedTracks,
          local: r.localTrackCount,
        }),
      );
    }
    const userEdited = (r.skipped ?? []).filter((x) => x.reason === "user_edited").map((x) => x.field).filter(Boolean);
    if (userEdited.length) {
      appendLog("detail", t("ui.studioMeta.log.keptUserEdits", { fields: userEdited.join(", ") }));
    }
    sourceErrorsLine(r.errors);
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
      appendLog("ok", t("ui.studioMeta.log.discogsApplied", { id: c.releaseId, title: c.title }));
      candidates = [];
      await Promise.all([session.loadAllAlbums(), session.syncCatalogDelta()]);
    } catch (e) {
      fail(e, "ui.studioMeta.log.applyError");
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
      const r = (await api.trackInfoFetchAlbum(selectedAlbum.folder_key)) as {
        fetched: number;
        failed: number;
        noMatch?: number;
        tracklist?: { source?: string; count?: number } | null;
        sourceErrors?: Array<{ source?: string; code?: string; message?: string }>;
      };
      const noMatch = Number(r.noMatch ?? 0) || 0;
      const total = r.fetched + r.failed + noMatch;
      if (total > 0) trackScanProg = { current: total, total };
      const parts = [tp("ui.studioMeta.log.tracksOk", r.fetched)];
      if (noMatch) parts.push(tp("ui.studioMeta.log.tracksNoMatch", noMatch));
      if (r.failed) parts.push(tp("ui.studioMeta.log.tracksErrors", r.failed));
      appendLog(r.failed || noMatch ? "warn" : "ok", t("ui.studioMeta.log.tracksLine", { parts: parts.join(", ") }));
      if (r.tracklist?.source) {
        appendLog("detail", t("ui.studioMeta.log.tracklistFrom", { source: r.tracklist.source }));
      }
      sourceErrorsLine(r.sourceErrors);
      await session.refreshAll();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      trackScanProg = null;
    }
  }

  async function runMetaScanAll(rescanAll: boolean) {
    const signal = startRun("meta");
    if (!signal) return;
    metaScanProg = null;
    let failures = 0;
    try {
      const list = session.allAlbums.filter((a) => !a.loose && a.folder_key);
      const toFetch = rescanAll ? list : list.filter((a) => !a.has_album_meta);
      const skipped = list.length - toFetch.length;
      appendLog(
        "info",
        tp(rescanAll ? "ui.studioMeta.log.albumScanStartAll" : "ui.studioMeta.log.albumScanStart", toFetch.length) +
          (skipped ? ` ${tp("ui.studioMeta.log.skipped", skipped)}` : ""),
      );
      if (!toFetch.length) {
        appendLog("ok", t("ui.studioMeta.log.albumNothing"));
        return;
      }
      for (let i = 0; i < toFetch.length; i++) {
        if (signal.aborted) break;
        const al = toFetch[i]!;
        metaScanProg = { current: i + 1, total: toFetch.length };
        try {
          await api.albumInfoFetch(al.folder_key, al.artist_name, al.name, { signal });
        } catch (e) {
          if (signal.aborted) break;
          failures += 1;
          appendLog("warn", `${i + 1}/${toFetch.length} ${al.artist_name} — ${al.name}: ${studioErrorText(e)}`);
        }
      }
      if (signal.aborted) {
        appendLog("warn", t("ui.studioMeta.log.albumStopped"));
        return;
      }
      appendLog(
        failures ? "warn" : "ok",
        failures
          ? t("ui.studioMeta.log.albumDoneWithErrors", { failed: tp("ui.studioMeta.log.albumsCount", failures) })
          : t("ui.studioMeta.log.albumDone"),
      );
      if (!destroyed) await session.loadAllAlbums();
    } finally {
      metaScanProg = null;
      endRun("meta");
    }
  }

  /** The whole library, page by page (the hub caps a single request). */
  async function loadAllTracks(signal: AbortSignal): Promise<Track[] | null> {
    const first = await api.tracksPage(TRACK_PAGE, 0, { signal });
    let items = first.items.slice();
    trackListProg = { current: items.length, total: first.total };
    for (let offset = TRACK_PAGE; offset < first.total; offset += TRACK_PAGE) {
      if (signal.aborted) return null;
      const page = await api.tracksPage(TRACK_PAGE, offset, { signal });
      if (!page.items.length) break;
      items = items.concat(page.items);
      trackListProg = { current: items.length, total: first.total };
    }
    return signal.aborted ? null : items;
  }

  async function runTrackScanAll(rescanAll: boolean) {
    const signal = startRun("track");
    if (!signal) return;
    trackScanProg = null;
    let failures = 0;
    let noMatches = 0;
    try {
      let tracks: Track[] | null;
      try {
        tracks = await loadAllTracks(signal);
      } catch (e) {
        if (!signal.aborted) err = studioErrorText(e);
        tracks = null;
      } finally {
        trackListProg = null;
      }
      if (!tracks) {
        if (signal.aborted) appendLog("warn", t("ui.studioMeta.log.trackStopped"));
        return;
      }
      const toFetch = rescanAll
        ? tracks
        : tracks.filter((tr) => !trackHasFileMeta(tr));
      const skipped = tracks.length - toFetch.length;
      appendLog(
        "info",
        tp(rescanAll ? "ui.studioMeta.log.trackScanStartAll" : "ui.studioMeta.log.trackScanStart", toFetch.length) +
          (skipped ? ` ${tp("ui.studioMeta.log.skipped", skipped)}` : ""),
      );
      if (!toFetch.length) {
        appendLog("ok", t("ui.studioMeta.log.trackNothing"));
        return;
      }
      for (let i = 0; i < toFetch.length; i++) {
        if (signal.aborted) break;
        const tr = toFetch[i]!;
        trackScanProg = { current: i + 1, total: toFetch.length };
        try {
          await api.trackInfoFetch(tr.rel_path, { signal });
        } catch (e) {
          if (signal.aborted) break;
          // No reliable match: nothing written, not an error.
          if (studioErrorCode(e) === "no_match") {
            noMatches += 1;
            continue;
          }
          failures += 1;
          appendLog("warn", `${i + 1}/${toFetch.length} ${tr.artist_name} — ${tr.title}: ${studioErrorText(e)}`);
        }
        if (i < toFetch.length - 1) await pause(TRACK_LOOKUP_GAP_MS, signal);
      }
      if (signal.aborted) {
        appendLog("warn", t("ui.studioMeta.log.trackStopped"));
        return;
      }
      if (noMatches) appendLog("detail", tp("ui.studioMeta.log.tracksNoMatchLine", noMatches));
      appendLog(
        failures ? "warn" : "ok",
        failures
          ? t("ui.studioMeta.log.trackDoneWithErrors", { failed: tp("ui.studioMeta.log.tracksErrors", failures) })
          : t("ui.studioMeta.log.trackDone"),
      );
      if (!destroyed) await session.refreshAll();
    } finally {
      trackScanProg = null;
      endRun("track");
    }
  }

  async function runPruneAll() {
    const ok = await confirmDialog({
      title: t("ui.studioMeta.pruneConfirmTitle"),
      message: t("ui.studioMeta.pruneConfirmMessage"),
      confirmLabel: t("ui.studioMeta.pruneConfirmOk"),
      danger: true,
    });
    if (!ok || destroyed) return;
    const signal = startRun("prune");
    if (!signal) return;
    pruneProg = null;
    let touched = 0;
    try {
      const list = session.allAlbums.filter((a) => !a.loose && a.folder_key);
      appendLog("info", tp("ui.studioMeta.log.pruneStart", list.length));
      for (let i = 0; i < list.length; i++) {
        if (signal.aborted) break;
        const al = list[i]!;
        pruneProg = { current: i + 1, total: list.length };
        try {
          const r = await api.pruneAlbumMetadata(al.folder_key, { signal });
          if (r.written || r.removed?.length) {
            touched += 1;
            if (r.removed?.length) {
              appendLog(
                "detail",
                t("ui.studioMeta.log.pruneRemoved", {
                  folder: al.folder_key,
                  keys: r.removed.slice(0, 6).join(", ") + (r.removed.length > 6 ? "…" : ""),
                }),
              );
            }
          }
        } catch (e) {
          if (signal.aborted) break;
          appendLog("warn", `${al.folder_key}: ${studioErrorText(e)}`);
        }
      }
      appendLog(
        signal.aborted ? "warn" : "ok",
        t(signal.aborted ? "ui.studioMeta.log.pruneStoppedLine" : "ui.studioMeta.log.pruneDoneLine", {
          albums: tp("ui.studioMeta.log.albumsTouched", touched),
        }),
      );
    } finally {
      pruneProg = null;
      endRun("prune");
    }
  }

  async function runSanitize(scope: "album" | "all", dryRun: boolean) {
    if (scope === "album" && !selectedAlbum) {
      appendLog("warn", t("ui.studioMeta.log.sanitizePickAlbum"));
      return;
    }
    if (!dryRun) {
      const ok = await confirmDialog({
        title: t("ui.studioMeta.sanitizeConfirmTitle"),
        message:
          scope === "all"
            ? t("ui.studioMeta.sanitizeConfirmAll")
            : t("ui.studioMeta.sanitizeConfirmAlbum", { album: selectedAlbum?.name ?? "" }),
        confirmLabel: t("ui.studioMeta.sanitizeConfirmOk"),
      });
      if (!ok || destroyed) return;
    }
    titleSanBusy = true;
    err = null;
    try {
      const r = await api.sanitizeTrackTitles({
        scope,
        albumPath: scope === "album" ? selectedAlbum!.folder_key : undefined,
        dryRun,
      });
      const skippedEdited = ((r as { skipped?: Array<{ reason?: string }> }).skipped ?? []).filter(
        (x) => x.reason === "user_edited",
      ).length;
      const changes: TitleChange[] = r.changes
        .map((c) => ({
          album: c.albumRel || c.albumPath || (scope === "album" ? (selectedAlbum?.folder_key ?? "") : ""),
          fileName: c.fileName,
          from: (c as { current?: string }).current || c.from,
          to: c.to,
        }))
        .sort(
          (a, b) =>
            a.album.localeCompare(b.album, i18n.sortLocale, { numeric: true }) ||
            a.fileName.localeCompare(b.fileName, i18n.sortLocale, { numeric: true }),
        );
      sanitize = { scope, dryRun, folder: selectedAlbum?.folder_key ?? "", changes, skippedEdited };
      const n = changes.length;
      appendLog(
        n ? "info" : "ok",
        dryRun
          ? n
            ? tp("ui.studioMeta.log.sanitizePreviewCount", n)
            : t("ui.studioMeta.log.sanitizeNone")
          : n
            ? tp("ui.studioMeta.log.sanitizeWritten", n)
            : t("ui.studioMeta.log.sanitizeNone"),
      );
      if (!dryRun && n) await session.refreshAll();
    } catch (e) {
      fail(e, "ui.studioMeta.log.sanitizeError");
    } finally {
      titleSanBusy = false;
    }
  }

  /** Sanitize preview grouped by album folder, in display order. */
  const sanitizeGroups = $derived.by(() => {
    if (!sanitize) return [];
    const groups: { album: string; rows: TitleChange[] }[] = [];
    for (const c of sanitize.changes.slice(0, SANITIZE_SHOWN)) {
      const last = groups[groups.length - 1];
      if (last && last.album === c.album) last.rows.push(c);
      else groups.push({ album: c.album, rows: [c] });
    }
    return groups;
  });

  function progressPct(p: Progress | null): number {
    return p && p.total > 0 ? Math.max(2, Math.min(100, (p.current / p.total) * 100)) : 0;
  }

  const albumScanPct = $derived(progressPct(metaScanProg));
  const trackScanPct = $derived(progressPct(trackScanProg));
  const trackListPct = $derived(progressPct(trackListProg));
  const prunePct = $derived(progressPct(pruneProg));
</script>

{#snippet progressBar(label: string, p: Progress, pct: number)}
  <div
    class="dl-progress-wrap"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={p.total}
    aria-valuenow={p.current}
  >
    <div class="dl-progress-top">
      <span>{label}</span>
      <span>{fmtNumber(p.current)}/{fmtNumber(p.total)}</span>
    </div>
    <div class="dl-progress-rail">
      <div class="dl-progress-fill" style="width: {pct}%"></div>
    </div>
  </div>
{/snippet}

<div class="studio-pane tools-meta" role="region" aria-label={t("ui.studioMeta.region")}>
  <StudioAccessNotice what={t("studio.access.metaReadOnly")} />
  <div class="studio-meta-split">
    <div class="studio-meta-split__primary">
      <div class="studio-panel studio-meta-picks">
        <div class="studio-picker-picks tools-studio-pair-picks">
          <div>
            <label class="subtle sm block-label" for="meta-artist-sel">
              {t("ui.studioMeta.artist")}
            </label>
            <select
              id="meta-artist-sel"
              class="rk-select"
              value={metaArtistId ?? ""}
              onchange={(e) => {
                const v = e.currentTarget.value;
                metaArtistId = v ? Number(v) : null;
                metaAlbumId = null;
              }}
            >
              <option value="">{t("ui.studioMeta.choose")}</option>
              {#each artistsSorted as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
          </div>
          <div>
            <label class="subtle sm block-label" for="meta-album-sel">
              {t("ui.studioMeta.album")}
            </label>
            <select
              id="meta-album-sel"
              class="rk-select"
              value={metaAlbumId ?? ""}
              disabled={!metaArtist}
              onchange={(e) => {
                const v = e.currentTarget.value;
                metaAlbumId = v ? Number(v) : null;
              }}
            >
              {#if !metaArtist}
                <option value="">{t("ui.studioMeta.pickArtistFirst")}</option>
              {:else}
                <option value="">{t("ui.studioMeta.chooseAlbum")}</option>
                {#each metaAlbums as al (al.id)}
                  <option value={al.id}>{al.name}</option>
                {/each}
              {/if}
            </select>
          </div>
        </div>
        <div class="studio-action-row studio-meta-fill-row">
          {#if selectedAlbum}
            <p class="art-target sm studio-meta-folder">
              {t("ui.studioMeta.folder", { folder: selectedAlbum.folder_key })}
            </p>
          {/if}
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            disabled={!session.current || studioBusy}
            onclick={fillFromPlayback}
          >
            {t("ui.studioMeta.fillFromPlayback")}
          </button>
        </div>
      </div>

      <div class="studio-panel studio-meta-essentials">
        <h4 class="studio-panel-title">{t("ui.studioMeta.essentials")}</h4>
        <div class="studio-action-groups">
          <div class="studio-action-group">
            <span class="studio-action-group-label">{t("ui.studioMeta.album")}</span>
            <p class="subtle sm studio-meta-essentials-hint">
              {t("ui.studioMeta.albumHint")}
            </p>
            <div class="studio-action-row studio-meta-equal-btns">
              <button
                type="button"
                class="primary-btn"
                disabled={!metaAlbumId || studioBusy || !canWrite}
                title={writeTitle}
                onclick={() => void fetchAlbum()}
              >
                {busy ? "…" : t("ui.studioMeta.selectedAlbum")}
              </button>
              <button
                type="button"
                class="ghost-btn"
                disabled={!session.allAlbums.length || studioBusy || !canWrite}
                title={writeTitle ?? t("ui.studioMeta.autoScanTitle")}
                onclick={() => (scanChoice = "album")}
              >
                {metaAllBusy ? t("ui.studioMeta.scanning") : t("ui.studioMeta.autoScan")}
              </button>
            </div>
          </div>
          <div class="studio-action-group">
            <span class="studio-action-group-label">{t("ui.studioMeta.tracks")}</span>
            <p class="subtle sm studio-meta-essentials-hint">
              {t("ui.studioMeta.tracksHint")}
            </p>
            <div class="studio-action-row studio-meta-equal-btns">
              <button
                type="button"
                class="primary-btn"
                disabled={!metaAlbumId || studioBusy || !canWrite}
                title={writeTitle}
                onclick={() => void fetchTracks()}
              >
                {t("ui.studioMeta.selectedAlbumTracks")}
              </button>
              <button
                type="button"
                class="ghost-btn"
                disabled={!session.allAlbums.length || studioBusy || !canWrite}
                title={writeTitle}
                onclick={() => (scanChoice = "track")}
              >
                {trackAllBusy ? t("ui.studioMeta.scanning") : t("ui.studioMeta.scanAllTracks")}
              </button>
            </div>
          </div>
        </div>

        {#if metaAllBusy && metaScanProg && metaScanProg.total > 0}
          {@render progressBar(t("ui.studioMeta.progressAlbums"), metaScanProg, albumScanPct)}
        {/if}
        {#if trackAllBusy && trackListProg && trackListProg.total > 0}
          {@render progressBar(t("ui.studioMeta.progressTrackList"), trackListProg, trackListPct)}
        {/if}
        {#if trackAllBusy && trackScanProg && trackScanProg.total > 0}
          {@render progressBar(t("ui.studioMeta.progressTracks"), trackScanProg, trackScanPct)}
        {/if}
        {#if pruneBusy && pruneProg && pruneProg.total > 0}
          {@render progressBar(t("ui.studioMeta.progressPrune"), pruneProg, prunePct)}
        {/if}
        {#if metaAllBusy || trackAllBusy || pruneBusy}
          <div class="studio-stop-row">
            {#if metaAllBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                disabled={stopping.meta}
                onclick={() => stopRun("meta")}
              >
                {t("ui.studioMeta.stopAlbums")}
              </button>
            {/if}
            {#if trackAllBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                disabled={stopping.track}
                onclick={() => stopRun("track")}
              >
                {t("ui.studioMeta.stopTracks")}
              </button>
            {/if}
            {#if pruneBusy}
              <button
                type="button"
                class="ghost-btn ghost-btn--sm"
                disabled={stopping.prune}
                onclick={() => stopRun("prune")}
              >
                {t("ui.studioMeta.stopPrune")}
              </button>
            {/if}
          </div>
        {/if}

        <div class="studio-meta-if-needed">
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            disabled={!session.allAlbums.length || studioBusy || !canWrite}
            title={writeTitle ?? t("ui.studioMeta.pruneTitle")}
            onclick={() => void runPruneAll()}
          >
            {pruneBusy ? "…" : t("ui.studioMeta.prune")}
          </button>
        </div>
      </div>
      {#if err}
        <p class="subtle sm warnline" role="alert">{err}</p>
      {/if}
    </div>

    <div class="studio-meta-split__secondary">
      <StudioLog
        class="studio-meta-log"
        entries={logEntries}
        onclear={() => {
          logEntries = [];
          err = null;
        }}
      />
    </div>
  </div>

  <section class="studio-panel studio-meta-optional" aria-labelledby="studio-meta-optional-title">
    <div class="studio-meta-optional__head">
      <h4 class="studio-panel-title" id="studio-meta-optional-title">{t("ui.studioMeta.optional")}</h4>
      <Segmented
        ariaLabel={t("ui.studioMeta.optional")}
        value={optionalTab}
        onchange={(v) => (optionalTab = v === "titles" ? "titles" : "einfo")}
        options={[
          { value: "einfo", label: t("ui.studioMeta.entityTitle") },
          { value: "titles", label: t("ui.studioMeta.fileTitles") },
        ]}
      />
    </div>

    <!-- Both stay mounted: switching tab keeps searches and picks. -->
    <div hidden={optionalTab !== "einfo"}>
      <StudioEntityInfoCard
        initialArtistId={metaArtistId}
        onlog={(kind, text) => appendLog(kind, text)}
      />
    </div>
    <div hidden={optionalTab !== "titles"}>
      <div class="studio-action-group studio-meta-titles">
        <p class="subtle sm studio-hint-line">{t("ui.studioMeta.fileTitlesHint")}</p>
        <div class="studio-meta-titles__actions">
          <div class="studio-meta-titles__group">
            <span class="studio-action-group-label">{t("ui.studioMeta.titlesScopeAlbum")}</span>
            <div class="studio-action-row">
              <button
                type="button"
                class="ghost-btn"
                disabled={!selectedAlbum || studioBusy}
                onclick={() => void runSanitize("album", true)}
              >
                {titleSanBusy ? "…" : t("ui.studioMeta.previewAlbum")}
              </button>
              <button
                type="button"
                class="primary-btn"
                disabled={!selectedAlbum || studioBusy || !canWrite}
                title={writeTitle}
                onclick={() => void runSanitize("album", false)}
              >
                {titleSanBusy ? "…" : t("ui.studioMeta.applyAlbum")}
              </button>
            </div>
            {#if !selectedAlbum}
              <p class="subtle sm">{t("ui.studioMeta.titlesNeedAlbum")}</p>
            {/if}
          </div>
          <div class="studio-meta-titles__group">
            <span class="studio-action-group-label">{t("ui.studioMeta.titlesScopeLibrary")}</span>
            <div class="studio-action-row">
              <button
                type="button"
                class="ghost-btn"
                disabled={!session.allAlbums.length || studioBusy}
                onclick={() => void runSanitize("all", true)}
              >
                {titleSanBusy ? "…" : t("ui.studioMeta.previewLibrary")}
              </button>
              <button
                type="button"
                class="primary-btn"
                disabled={!session.allAlbums.length || studioBusy || !canWrite}
                title={writeTitle}
                onclick={() => void runSanitize("all", false)}
              >
                {titleSanBusy ? "…" : t("ui.studioMeta.applyLibrary")}
              </button>
            </div>
          </div>
        </div>

        {#if sanitize}
          <div class="studio-sanitize" aria-live="polite">
            <div class="studio-sanitize__head">
              <strong>
                {sanitize.dryRun
                  ? t("ui.studioMeta.sanitizePreviewTitle")
                  : t("ui.studioMeta.sanitizeWrittenTitle")}
              </strong>
              <span class="subtle sm">
                {sanitize.changes.length
                  ? tp("ui.studioMeta.sanitizeCount", sanitize.changes.length)
                  : t("ui.studioMeta.log.sanitizeNone")}
              </span>
              {#if sanitize.skippedEdited}
                <span class="subtle sm">{tp("ui.studioMeta.sanitizeSkippedEdited", sanitize.skippedEdited)}</span>
              {/if}
              {#if sanitize.dryRun && sanitize.changes.length}
                <button
                  type="button"
                  class="primary-btn primary-btn--sm"
                  disabled={studioBusy || !canWrite || (sanitize.scope === "album" && !selectedAlbum)}
                  title={writeTitle}
                  onclick={() => void runSanitize(sanitize!.scope, false)}
                >
                  {t("ui.studioMeta.sanitizeApplyThese")}
                </button>
              {/if}
              <button type="button" class="linkbtn" onclick={() => (sanitize = null)}>
                {t("ui.studioMeta.sanitizeClose")}
              </button>
            </div>
            {#if sanitizeGroups.length}
              <div class="studio-sanitize__body rk-scroll">
                {#each sanitizeGroups as g (g.album)}
                  <div class="studio-sanitize__group">
                    {#if sanitize.scope === "all"}
                      <p class="studio-sanitize__album">{g.album}</p>
                    {/if}
                    <ul class="studio-sanitize__list">
                      {#each g.rows as c, i (`${c.fileName}:${i}`)}
                        <li class="studio-sanitize__row">
                          <span class="studio-sanitize__from" title={c.fileName}>{c.from}</span>
                          <span class="studio-sanitize__arrow" aria-hidden="true">→</span>
                          <span class="studio-sanitize__to">{c.to}</span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/each}
                {#if sanitize.changes.length > SANITIZE_SHOWN}
                  <p class="subtle sm">
                    {tp("ui.studioMeta.log.sanitizeMore", sanitize.changes.length - SANITIZE_SHOWN)}
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </section>
</div>

<!-- Both dialogs use the design-system Modal (header + close, scrolling
     body, action bar; a bottom sheet on the phone). -->
<Modal
  open={discogsOpen && candidates.length > 0}
  eyebrow="Discogs"
  title={t("ui.studioMeta.discogsTitle")}
  lede={t("ui.studioMeta.discogsHint")}
  panelClass="studio-discogs-picker"
  onclose={() => (discogsOpen = false)}
>
  <ul class="studio-discogs-picker__list" aria-busy={busy}>
    {#each candidates as c, i (`${c.releaseId}:${i}`)}
      <li>
        <button
          type="button"
          class="studio-discogs-picker__item"
          disabled={busy || !canWrite}
          onclick={() => void applyDiscogs(c)}
        >
          {#if c.thumb}
            <img src={c.thumb} alt="" class="studio-discogs-picker__thumb" loading="lazy" />
          {:else}
            <span class="studio-discogs-picker__thumb studio-discogs-picker__thumb--empty" aria-hidden="true">
              <UiIcon name="album" />
            </span>
          {/if}
          <span class="studio-discogs-picker__body">
            <span class="studio-discogs-picker__title">{c.title}</span>
            <span class="studio-discogs-picker__meta">
              {[c.year, c.country, c.label].filter(Boolean).join(" · ")}
            </span>
          </span>
          {#if c.score != null}
            <span class="studio-discogs-picker__score" title={t("studio.meta.discogsScore", { n: Math.round(c.score) })}>
              {Math.round(c.score)}
            </span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button variant="ghost" onclick={() => (discogsOpen = false)}>{t("ui.confirm.cancel")}</Button>
  {/snippet}
</Modal>

<Modal
  open={scanChoice != null}
  eyebrow={t("studio.header.meta")}
  title={scanChoice === "album"
    ? t("ui.studioMeta.scanChoiceAlbumTitle")
    : t("ui.studioMeta.scanChoiceTrackTitle")}
  panelClass="studio-scan-choice"
  onclose={() => (scanChoice = null)}
>
  <p class="studio-scan-choice__hint">
    {scanChoice === "album"
      ? t("ui.studioMeta.scanChoiceAlbumHint")
      : t("ui.studioMeta.scanChoiceTrackHint")}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (scanChoice = null)}>{t("ui.confirm.cancel")}</Button>
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button
      variant="ghost"
      onclick={() => {
        const k = scanChoice;
        scanChoice = null;
        if (k === "album") void runMetaScanAll(true);
        else void runTrackScanAll(true);
      }}
    >
      {t("ui.studioMeta.rescanAll")}
    </Button>
    <Button
      onclick={() => {
        const k = scanChoice;
        scanChoice = null;
        if (k === "album") void runMetaScanAll(false);
        else void runTrackScanAll(false);
      }}
    >
      {t("ui.studioMeta.onlyMissing")}
    </Button>
  {/snippet}
</Modal>
