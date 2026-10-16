/**
 * Podcast e notizie: stato di ascolto (ripresa, ascoltato), righe episodio,
 * elementi esterni nel player (fuori da statistiche, conteggi e sync coda).
 * Si lancia con `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ENTRIES,
  capEntries,
  emptyState,
  entryId,
  episodeProgress,
  episodesFor,
  formatDuration,
  markListened,
  mergeStates,
  minutesLeft,
  normalizeState,
  recordProgress,
  visibleSources,
} from "./podcastModel.ts";
import {
  countsTowardStats,
  externalArtPath,
  externalMediaPath,
  externalTrackId,
  isExternalTrack,
  isLiveTrack,
  libraryQueueForSync,
  makeExternalTrack,
  parseExternalPath,
} from "./externalItems.ts";

const meta = { sourceId: 3, key: "ab12cd34ef56ab78", title: "Edizione delle 15", sourceName: "RTL 102.5" };

test("posizione salvata e ripresa", () => {
  let s = recordProgress(emptyState(), meta, 125.4, 600, 1000);
  const e = s.e[entryId(3, meta.key)];
  assert.equal(e.p, 125);
  assert.equal(e.d, 600);
  assert.equal(e.l, false);
  const prog = episodeProgress(e, 600);
  assert.equal(prog.resumeAt, 125);
  assert.ok(Math.abs(prog.ratio - 125 / 600) < 1e-9);
  assert.equal(minutesLeft(e, 600), 8);
  // Pochi secondi: si riparte dall'inizio.
  s = recordProgress(s, meta, 6, 600, 2000);
  assert.equal(episodeProgress(s.e[entryId(3, meta.key)], 600).resumeAt, 0);
});

test("arrivati in fondo: ascoltato, e niente ripresa", () => {
  const s = recordProgress(emptyState(), meta, 590, 600, 1000);
  const e = s.e[entryId(3, meta.key)];
  assert.equal(e.l, true);
  const prog = episodeProgress(e, 600);
  assert.equal(prog.listened, true);
  assert.equal(prog.resumeAt, 0);
  assert.equal(prog.ratio, 1);
  // Riascoltare da capo non toglie il segno.
  const again = recordProgress(s, meta, 30, 600, 2000);
  assert.equal(again.e[entryId(3, meta.key)].l, true);
});

test("segna come ascoltato / da ascoltare", () => {
  let s = recordProgress(emptyState(), meta, 200, 600, 1000);
  s = markListened(s, meta, true, 2000);
  assert.equal(s.e[entryId(3, meta.key)].l, true);
  assert.equal(s.e[entryId(3, meta.key)].p, 0);
  s = markListened(s, meta, false, 3000);
  const prog = episodeProgress(s.e[entryId(3, meta.key)], 600);
  assert.equal(prog.listened, false);
  assert.equal(prog.started, false);
});

test("durata sconosciuta e diretta", () => {
  const s = recordProgress(emptyState(), meta, 90, 0, 1000);
  const e = s.e[entryId(3, meta.key)];
  assert.equal(e.l, false);
  assert.equal(episodeProgress(e, null).ratio, 0);
  assert.equal(episodeProgress(e, null).resumeAt, 90);
  const live = recordProgress(emptyState(), { ...meta, key: "live", live: true }, 999, 0, 1000);
  const le = live.e[entryId(3, "live")];
  assert.equal(le.p, 0);
  assert.equal(episodeProgress(le, null).resumeAt, 0);
});

test("al massimo MAX_ENTRIES voci, si tengono le più recenti", () => {
  let s = emptyState();
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    s = recordProgress(s, { ...meta, key: `k${i}` }, 10, 100, i + 1);
  }
  const ids = Object.keys(s.e);
  assert.equal(ids.length, MAX_ENTRIES);
  assert.ok(!(entryId(3, "k0") in s.e));
  assert.ok(entryId(3, `k${MAX_ENTRIES + 24}`) in s.e);
  assert.equal(capEntries(s, 5).e && Object.keys(capEntries(s, 5).e).length, 5);
});

test("fusione tra dispositivi: vince la modifica più recente di ogni voce", () => {
  const a = recordProgress(recordProgress(emptyState(), meta, 100, 600, 1000), { ...meta, key: "x1" }, 5, 60, 5000);
  const b = recordProgress(emptyState(), meta, 300, 600, 2000);
  const m = mergeStates(a, b);
  assert.equal(m.e[entryId(3, meta.key)].p, 300);
  assert.ok(entryId(3, "x1") in m.e);
  // Dati malformati non rompono nulla.
  assert.deepEqual(normalizeState({ e: { bad: { p: 1 }, "3:ok": "x" } }), emptyState());
  assert.deepEqual(normalizeState(null), emptyState());
});

test("righe: durata leggibile, fonti visibili, limite episodi", () => {
  assert.equal(formatDuration(247), "4:07");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(null), "");
  const src = { id: 1, name: "A", kind: "rss", live: false, episodeCount: 2, hasArt: false, fetchedAt: null, error: null, episodes: [{ key: "a", title: "1" }, { key: "b", title: "2" }, { key: "c", title: "3" }] };
  assert.equal(episodesFor(src).length, 2);
  const empty = { ...src, id: 2, episodes: [] };
  const broken = { ...empty, id: 3, error: "podcast_fetch_failed" };
  assert.deepEqual(visibleSources([src, empty, broken]).map((s) => s.id), [1, 3]);
});

test("elemento esterno: percorso, id, URL del proxy, copertina", () => {
  const tr = makeExternalTrack({ sourceId: 7, sourceName: "NPR", key: "f8785a0a38556cbb", title: "News", live: false, durationSecs: 280, art: true });
  assert.equal(tr.rel_path, "ext:pod/7/f8785a0a38556cbb");
  assert.ok(tr.id < -999_999);
  assert.equal(tr.id, externalTrackId(7, "f8785a0a38556cbb"));
  assert.equal(tr.duration_ms, 280_000);
  assert.ok(isExternalTrack(tr));
  assert.ok(!isLiveTrack(tr));
  assert.deepEqual(parseExternalPath(tr.rel_path), { sourceId: 7, key: "f8785a0a38556cbb" });
  assert.equal(externalMediaPath(tr.rel_path), "/api/v1/podcasts/play/7/f8785a0a38556cbb");
  assert.equal(externalArtPath(tr), "/api/v1/podcasts/art/7/f8785a0a38556cbb");
  assert.equal(parseExternalPath("ext:pod/x/../etc"), null);
  assert.equal(parseExternalPath("Artist/Album/01.mp3"), null);
  const live = makeExternalTrack({ sourceId: 2, sourceName: "Radio", key: "live", title: "Radio", live: true, durationSecs: 999 });
  assert.ok(isLiveTrack(live));
  assert.equal(live.duration_ms, 0);
  assert.equal(externalArtPath(live), null);
});

test("fuori da statistiche, conteggi e coda dell'hub", () => {
  const lib = (p) => ({ rel_path: p });
  const ep = makeExternalTrack({ sourceId: 1, sourceName: "S", key: "k1", title: "E", live: false });
  assert.equal(countsTowardStats(ep), false);
  assert.equal(countsTowardStats(lib("A/B/1.mp3")), true);
  assert.equal(countsTowardStats(null), false);
  const queue = [lib("a"), ep, lib("b"), lib("c")];
  // Corrente = episodio: la coda sincronizzata salta l'episodio e il cursore
  // resta sull'ultimo brano della libreria prima di lui.
  let s = libraryQueueForSync(queue, 1);
  assert.deepEqual(s.tracks.map((t) => t.rel_path), ["a", "b", "c"]);
  assert.equal(s.index, 0);
  assert.equal(s.currentIsLibrary, false);
  s = libraryQueueForSync(queue, 2);
  assert.equal(s.index, 1);
  assert.equal(s.currentIsLibrary, true);
  s = libraryQueueForSync([ep], 0);
  assert.deepEqual(s.tracks, []);
  assert.equal(s.index, 0);
});

test("Nuovo, Ultimi e scheda ricordata", async () => {
  const { isNewEpisode, latestAcross, resolveTab } = await import("./podcastModel.ts");
  const now = Date.parse("2026-10-07T15:00:00Z");
  assert.equal(isNewEpisode({ publishedAt: "2026-10-07T14:10:00Z" }, now), true);
  assert.equal(isNewEpisode({ publishedAt: "2026-10-07T12:00:00Z" }, now), false);
  assert.equal(isNewEpisode({ publishedAt: null }, now), false);
  assert.equal(isNewEpisode({ publishedAt: "2026-10-07T14:59:00Z", live: true }, now), false);
  const mk = (id, live, dates) => ({
    id, name: `S${id}`, kind: live ? "live" : "rss", live, episodeCount: 5, hasArt: false, fetchedAt: null, error: null,
    episodes: dates.map((d, i) => ({ key: `${id}e${i}`, title: `${id}-${i}`, publishedAt: d })),
  });
  const a = mk(1, false, ["2026-10-07T14:00:00Z", "2026-10-07T13:00:00Z", "2026-10-07T12:00:00Z", "2026-10-07T11:00:00Z"]);
  const b = mk(2, false, ["2026-10-07T13:30:00Z", null]);
  const live = mk(3, true, [null]);
  const list = latestAcross([a, b, live], 3, 10);
  assert.deepEqual(list.map((x) => x.ep.key), ["1e0", "2e0", "1e1", "1e2", "2e1"]);
  assert.equal(resolveTab("2", [a, b]), "2");
  assert.equal(resolveTab("99", [a, b]), "latest");
  assert.equal(resolveTab(null, [a, b]), "latest");
  assert.equal(resolveTab("latest", [a]), "1");
});
