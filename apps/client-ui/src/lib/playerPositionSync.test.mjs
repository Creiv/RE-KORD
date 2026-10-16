/**
 * Positions that belong to one item must never be stored for another, on the
 * real PlayerController and podcast store with fake <audio> decks and mocked
 * timers:
 * - switching from a podcast episode to an album: while the album's first
 *   track buffers, the episode still sounds on the other deck; its position
 *   must not reach the saved / synced cursor of the album track;
 * - a restored position past the track's end starts it from the top;
 * - an episode's resume point survives a library track playing and a failed
 *   (502) reload of the episode.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileModule } from "svelte/compiler";

// ---- Loading player.ts outside Vite (same hooks as playerCrossfade.test.mjs) --
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".svelte")) {
      const guess = `${specifier}.ts`;
      if (existsSync(fileURLToPath(new URL(guess, context.parentURL)))) return next(guess, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".svelte.ts")) {
      const file = fileURLToPath(url);
      const src = stripTypeScriptTypes(readFileSync(file, "utf8")).replace(
        /import\.meta\.glob\s*\([^)]*\)/g,
        "({})",
      );
      const out = compileModule(src, { generate: "client", filename: file });
      return { format: "module", source: out.js.code, shortCircuit: true };
    }
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return {
        format: "module",
        source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});

// ---- Browser stand-ins -------------------------------------------------------
class FakeStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  get length() { return this.#m.size; }
}

const winEvents = new EventTarget();
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: winEvents.addEventListener.bind(winEvents),
  removeEventListener: winEvents.removeEventListener.bind(winEvents),
  dispatchEvent: winEvents.dispatchEvent.bind(winEvents),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: new FakeStorage(),
  sessionStorage: new FakeStorage(),
  location: new URL("http://127.0.0.1:7422/"),
  document: Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hidden: false,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
  }),
  HTMLMediaElement: { HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4 },
  MediaError: { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 },
});
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node-test", languages: ["it"], language: "it", onLine: true },
  configurable: true,
});
/** The hub answers everything (/health included): a media error is the file's. */
globalThis.fetch = async () =>
  new Response(JSON.stringify({ service: "RE-KORD", version: "5.1.0" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Element duration per path fragment (seconds); 40 otherwise. */
const lengths = new Map();
/** Paths whose load gets no answer yet (buffering). */
const hung = new Set();
/** Paths whose load fails (the feed answered 502 through the proxy). */
const failing = new Set();

class FakeAudio extends EventTarget {
  static all = [];
  constructor() {
    super();
    FakeAudio.all.push(this);
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.ended = false;
    this.error = null;
    this.readyState = 0;
    this.networkState = 0;
    this.seeking = false;
    this.preload = "";
    this.crossOrigin = null;
    this.loop = false;
    this._src = null;
    this._volume = 1;
  }
  get volume() { return this._volume; }
  set volume(v) { this._volume = v; }
  get src() { return this._src ? new URL(this._src, location.href).href : ""; }
  set src(v) { this._src = v; }
  get currentSrc() { return this.src; }
  getAttribute(k) { return k === "src" ? this._src : null; }
  setAttribute(k, v) { if (k === "src") this._src = v; }
  removeAttribute(k) { if (k === "src") this._src = null; }
  fire(type) { this.dispatchEvent(new Event(type)); }
  path() { return decodeURIComponent(this._src ?? ""); }
  matches(set) { return [...set].some((r) => this.path().includes(r)); }
  load() {
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.currentTime = 0;
    this.readyState = 0;
    this.duration = NaN;
    if (!this._src || this.matches(hung)) return;
    if (this.matches(failing)) {
      queueMicrotask(() => {
        this.error = { code: 4 };
        this.fire("error");
      });
      return;
    }
    this.readyState = 4;
    const len = [...lengths].find(([k]) => this.path().includes(k));
    this.duration = len ? len[1] : 40;
    queueMicrotask(() => {
      this.fire("loadedmetadata");
      this.fire("durationchange");
      this.fire("canplay");
    });
  }
  play() {
    if (this.readyState === 0) return new Promise(() => {});
    const was = this.paused;
    this.paused = false;
    if (was) queueMicrotask(() => { this.fire("play"); this.fire("playing"); });
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.fire("pause"));
  }
}
globalThis.Audio = FakeAudio;
globalThis.HTMLAudioElement = FakeAudio;
globalThis.Image = class { decoding = ""; src = ""; };

mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
Object.defineProperty(globalThis, "performance", { value: { now: () => Date.now() }, configurable: true });
const { player } = await import("./player.ts");
const { makeExternalTrack } = await import("./externalItems.ts");
const { podcasts } = await import("./podcasts/store.svelte.ts");
const { entryId, cardAction, recordProgress, emptyState } = await import("./podcastModel.ts");
const { session } = await import("./session.svelte.ts");

// ---- Helpers -----------------------------------------------------------------
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const tick = async (ms) => {
  for (let left = ms; left > 0; left -= 100) {
    mock.timers.tick(Math.min(100, left));
    await flush();
  }
};
const song = (n, title, sec) => ({
  id: n,
  rel_path: `Eagles/Desperado/${String(n).padStart(2, "0")} - ${title}.mp3`,
  title,
  artist_name: "Eagles",
  album_name: "Desperado",
  duration_ms: sec * 1000,
  track_number: n,
  album_id: 7,
  artist_id: 7,
});
const DOOLIN = song(1, "Doolin-Dalton", 207);
const album = [DOOLIN, song(2, "Twenty-One", 151), song(3, "Out of Control", 184)];
for (const t of album) lengths.set(t.title, t.duration_ms / 1000);

const SOURCE = { id: 3, name: "Il Podcast", kind: "rss", live: false, episodeCount: 1, hasArt: false, fetchedAt: null, error: null };
const EP = { key: "ep311", title: "Puntata", durationSecs: 3600 };
SOURCE.episodes = [EP];
const episode = makeExternalTrack({
  sourceId: SOURCE.id,
  sourceName: SOURCE.name,
  key: EP.key,
  title: EP.title,
  durationSecs: EP.durationSecs,
});
lengths.set("/podcasts/play/3/ep311", 3600);

/** The deck sounding `fragment` (else the newest holding it). */
const deckWith = (fragment) => {
  const decks = FakeAudio.all.filter((a) => a.path().includes(fragment));
  return decks.find((a) => !a.paused) ?? decks.at(-1);
};
const advance = async (el, t) => {
  el.currentTime = t;
  el.fire("timeupdate");
  await flush();
};
/** Setting `src` loads in a browser; the fake waits to be told. */
const browserLoads = async () => {
  deckWith("Doolin-Dalton").load();
  await tick(200);
};
const savedPosition = () => JSON.parse(localStorage.getItem("rekord.next.sessionPosition.default") ?? "null");

const syncs = [];
player.setQueueSync((change) => syncs.push(structuredClone(change.snapshot)));

async function reset() {
  hung.clear();
  failing.clear();
  player.clearQueue();
  await tick(500);
  syncs.length = 0;
}

// ---- Tests -------------------------------------------------------------------
test("an episode's position never rides on the album track that replaces it", async () => {
  await reset();
  player.playExternal(episode, { startAt: 300 });
  await tick(200);
  const epDeck = deckWith("/podcasts/play/3/ep311");
  assert.ok(epDeck && !epDeck.paused, "the episode plays");
  await advance(epDeck, 311);
  assert.equal(player.currentTime, 311);

  // The album's first track takes a moment to answer; the episode sounds on.
  hung.add("Doolin-Dalton");
  player.playSequence(album, 0);
  await flush();
  assert.equal(player.current?.title, "Doolin-Dalton");
  await advance(epDeck, 311.4);
  await advance(epDeck, 311.8);
  assert.equal(player.currentTime, 0, "the timeline is the new track's");
  // The queue flush (list + cursor to the hub) and the browser closing now.
  await tick(400);
  dispatchEvent(new Event("pagehide"));
  await flush();

  const forDoolin = syncs.filter((s) => s.relPath === DOOLIN.rel_path);
  assert.ok(forDoolin.length > 0, "the album went to the hub");
  for (const s of forDoolin) assert.equal(s.time, 0, `synced at ${s.time}s`);
  const pos = savedPosition();
  assert.equal(pos.relPath, DOOLIN.rel_path);
  assert.equal(pos.time, 0, "saved locally at 0, not the episode's 311 s");
  assert.ok(player.queueSnapshot().time <= 207);

  // Once it plays, its own position goes through as usual.
  hung.clear();
  const d = deckWith("Doolin-Dalton");
  d.load();
  await tick(300);
  assert.ok(!d.paused, "Doolin-Dalton plays");
  await advance(d, 42);
  assert.equal(player.queueSnapshot().time, 42);
});

test("the hub queue never carries an episode's position", async () => {
  await reset();
  player.playSequence(album, 0);
  await tick(200);
  await advance(deckWith("Doolin-Dalton"), 30);
  player.playExternal(episode, { startAt: 300 });
  await tick(200);
  await advance(deckWith("/podcasts/play/3/ep311"), 311);
  const snap = player.queueSnapshot();
  assert.deepEqual(snap.relPaths, album.map((t) => t.rel_path), "library tracks only");
  assert.equal(snap.relPath, DOOLIN.rel_path);
  assert.equal(snap.time, 0);
});

test("a restored position past the track's end starts it from the top", async () => {
  await reset();
  // What an abrupt close left behind before the fix: 5:11 on a 3:27 track.
  player.releaseAccount({ sync: false });
  player.bindAccount("restore-a");
  localStorage.setItem(
    "rekord.next.sessionQueue.restore-a",
    JSON.stringify({ version: 1, tracks: album, currentIndex: 0, updatedAt: 1 }),
  );
  localStorage.setItem(
    "rekord.next.sessionPosition.restore-a",
    JSON.stringify({ relPath: DOOLIN.rel_path, time: 311, updatedAt: 1 }),
  );
  assert.equal(player.restorePersistedQueue(album), true);
  assert.equal(player.current?.title, "Doolin-Dalton");
  assert.equal(player.currentTime, 0, "not at 5:11");
  await browserLoads();
  assert.equal(player.currentTime, 0);
  assert.equal(deckWith("Doolin-Dalton").currentTime, 0, "no seek past the end");

  // Same from the hub's copy (newer than the local one).
  player.releaseAccount({ sync: false });
  player.bindAccount("restore-b");
  const hub = {
    relPaths: album.map((t) => t.rel_path),
    index: 0,
    relPath: DOOLIN.rel_path,
    time: 311,
    updatedAt: Date.now(),
  };
  assert.equal(player.restorePersistedQueue(album, hub), true);
  assert.equal(player.currentTime, 0);
  await browserLoads();
  assert.equal(deckWith("Doolin-Dalton").currentTime, 0);

  // A track the catalog has no length for: the element's length decides.
  player.releaseAccount({ sync: false });
  player.bindAccount("restore-c");
  assert.equal(player.restorePersistedQueue([], { ...hub, updatedAt: Date.now() }), true);
  await browserLoads();
  assert.equal(player.currentTime, 0, "out of range once the element knows the length");
  assert.equal(deckWith("Doolin-Dalton").currentTime, 0);

  // A position in range is still restored.
  player.releaseAccount({ sync: false });
  player.bindAccount("restore-d");
  assert.equal(player.restorePersistedQueue(album, { ...hub, time: 95, updatedAt: Date.now() }), true);
  assert.equal(player.currentTime, 95);
  await browserLoads();
  assert.equal(deckWith("Doolin-Dalton").currentTime, 95);

  player.releaseAccount({ sync: false });
  player.bindAccount(null);
});

test("an episode's resume point survives a library track and a 502 on its reload", async () => {
  await reset();
  podcasts.sources = [SOURCE];
  const id = entryId(SOURCE.id, EP.key);
  const resumeAt = () => podcasts.state.e[id]?.p;

  player.playSequence(album, 0);
  await tick(200);
  podcasts.play(SOURCE, EP);
  await tick(200);
  await advance(deckWith("/podcasts/play/3/ep311"), 311);

  // Back to the album: the episode's position goes in at the switch.
  player.playQueueIndex(player.queue.findIndex((t) => t.rel_path === DOOLIN.rel_path));
  await tick(200);
  assert.equal(resumeAt(), 311);
  const lib = deckWith("Doolin-Dalton");
  assert.ok(lib && !lib.paused, "Doolin-Dalton plays");
  await advance(lib, 14);

  // The episode again, but the feed answers 502: the library deck sounds on
  // while it fails, then the player skips it.
  failing.add("/podcasts/play/3/ep311");
  podcasts.play(SOURCE, EP);
  await advance(lib, 14.3);
  await tick(300);
  await advance(lib, 14.6);
  await tick(3000);
  assert.notEqual(player.current?.rel_path, episode.rel_path, "the failed episode was skipped");
  dispatchEvent(new Event("pagehide"));
  await flush();
  assert.equal(resumeAt(), 311, "the resume point is kept");
  assert.equal(cardAction(podcasts.state, SOURCE).kind, "ask", "the dashboard still offers to continue");
});

test("an episode that fails to load keeps its resume point", async () => {
  await reset();
  podcasts.sources = [SOURCE];
  const id = entryId(SOURCE.id, EP.key);
  session.setSyncedSetting(
    "podcasts",
    recordProgress(emptyState(), { sourceId: SOURCE.id, key: EP.key, title: EP.title, sourceName: SOURCE.name }, 311, 3600),
  );
  assert.equal(podcasts.state.e[id]?.p, 311);
  failing.add("/podcasts/play/3/ep311");
  podcasts.play(SOURCE, EP);
  await tick(3000);
  player.pause();
  dispatchEvent(new Event("pagehide"));
  await flush();
  assert.equal(podcasts.state.e[id]?.p, 311, "not 0 from the load that never started");
  failing.clear();
});

test("positionOf only answers for the item really playing", async () => {
  await reset();
  player.playSequence(album, 0);
  await tick(200);
  const lib = deckWith("Doolin-Dalton");
  await advance(lib, 20);
  assert.equal(player.positionOf(DOOLIN.rel_path), 20);
  assert.equal(player.positionOf(episode.rel_path), null, "not current");

  hung.add("/podcasts/play/3/ep311");
  player.playExternal(episode, { startAt: 300 });
  await flush();
  await advance(lib, 21);
  assert.equal(player.positionOf(episode.rel_path), null, "still buffering");
  hung.clear();
  await reset();
});
