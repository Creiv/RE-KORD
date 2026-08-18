/**
 * Preferenze da ripulire quando un brano lascia il disco: se restasse una
 * esclusione o un mood, tornerebbero in vita sul brano che un giorno riusera'
 * quel percorso.
 *
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const { prefsWithoutTracks } = await import("./userPrefs.ts");

/** Solo i campi che la funzione guarda: il resto delle preferenze non c'entra. */
function prefs(over = {}) {
  return {
    excludedRelPaths: [],
    excludedTrackIds: [],
    recentRelPaths: [],
    recentTrackIds: [],
    playCounts: {},
    trackMoods: {},
    ...over,
  };
}

const GONE = "Artist/Album/01.mp3";
const KEPT = "Artist/Album/02.mp3";

test("senza brani da dimenticare non tocca niente", () => {
  const patch = prefsWithoutTracks(prefs({ recentRelPaths: [GONE] }), { relPaths: [] });
  assert.deepEqual(patch, {});
});

test("il percorso sparisce da recenti, esclusioni, ascolti e mood", () => {
  const patch = prefsWithoutTracks(
    prefs({
      excludedRelPaths: [GONE, KEPT],
      recentRelPaths: [KEPT, GONE],
      playCounts: { [GONE]: 12, [KEPT]: 3 },
      trackMoods: { [GONE]: ["notte"], [KEPT]: ["festa"] },
    }),
    { relPaths: [GONE] },
  );

  assert.deepEqual(patch.excludedRelPaths, [KEPT]);
  assert.deepEqual(patch.recentRelPaths, [KEPT]);
  assert.deepEqual(patch.playCounts, { [KEPT]: 3 });
  assert.deepEqual(patch.trackMoods, { [KEPT]: ["festa"] });
});

test("anche le chiavi numeriche rimaste dall'import legacy se ne vanno", () => {
  const patch = prefsWithoutTracks(
    prefs({
      excludedTrackIds: [7, 9],
      recentTrackIds: [7, 9],
      playCounts: { 7: 4, [KEPT]: 1 },
      trackMoods: { 7: ["calmo"] },
    }),
    { relPaths: [GONE], trackIds: [7] },
  );

  assert.deepEqual(patch.excludedTrackIds, [9]);
  assert.deepEqual(patch.recentTrackIds, [9]);
  assert.deepEqual(patch.playCounts, { [KEPT]: 1 });
  assert.deepEqual(patch.trackMoods, {});
});

test("l'ordine dei recenti non cambia per chi resta", () => {
  const patch = prefsWithoutTracks(
    prefs({ recentRelPaths: ["a.mp3", GONE, "b.mp3", "c.mp3"] }),
    { relPaths: [GONE] },
  );
  assert.deepEqual(patch.recentRelPaths, ["a.mp3", "b.mp3", "c.mp3"]);
});

test("un album intero: tutti i suoi brani in un colpo", () => {
  const album = ["Artist/Album/01.mp3", "Artist/Album/02.mp3", "Artist/Album/CD2/01.mp3"];
  const patch = prefsWithoutTracks(
    prefs({
      recentRelPaths: [...album, "Other/Album/01.mp3"],
      playCounts: Object.fromEntries(album.map((p, i) => [p, i + 1])),
      trackMoods: Object.fromEntries(album.map((p) => [p, ["notte"]])),
    }),
    { relPaths: album },
  );

  assert.deepEqual(patch.recentRelPaths, ["Other/Album/01.mp3"]);
  assert.deepEqual(patch.playCounts, {});
  assert.deepEqual(patch.trackMoods, {});
});
