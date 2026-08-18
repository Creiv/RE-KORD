/**
 * Riproduzione casuale intelligente: cosa resta fermo, cosa si mescola, e come
 * si tengono lontani due brani dello stesso artista.
 *
 * Le preferenze si leggono da localStorage, che in node non esiste: qui basta un
 * archivio vuoto, cosi' i mood salvati non entrano in gioco e i punteggi
 * dipendono solo da genere e artista.
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

const {
  CARD_QUEUE_CAP,
  buildRadioFromSeed,
  buildShuffleQueueFromSeed,
  buildSmartRandomQueue,
  filterPoolForExclusions,
  fisherYatesShuffle,
  seedSimilarityScore,
  shuffleTailFromCurrent,
} = await import("./smartShuffle.ts");

let nextId = 1;
const track = (artist, genre = null, relPath = null) => ({
  id: nextId++,
  rel_path: relPath ?? `${artist}/${nextId}.mp3`,
  title: `Brano ${nextId}`,
  artist_name: artist,
  album_name: "Album",
  album_id: 1,
  genre,
});

const paths = (list) => list.map((t) => t.rel_path).sort();
const adjacentSameArtist = (list) =>
  list.filter((t, i) => i > 0 && list[i - 1].artist_name === t.artist_name).length;

test("mescolare non perde e non duplica brani, e non tocca la lista di partenza", () => {
  const pool = [track("A"), track("B"), track("C"), track("D")];
  const out = fisherYatesShuffle(pool);
  assert.deepEqual(paths(out), paths(pool));
  assert.deepEqual(pool.map((t) => t.artist_name), ["A", "B", "C", "D"]);
});

test("mescolare la coda lascia dov'e' quello che si e' già ascoltato", () => {
  const pool = [track("A"), track("B"), track("C"), track("D"), track("E")];
  const out = shuffleTailFromCurrent(pool, 1);
  assert.deepEqual(out.slice(0, 2), pool.slice(0, 2));
  assert.deepEqual(paths(out), paths(pool));
});

test("code corte: non c'e' niente da mescolare", () => {
  const one = [track("A")];
  assert.deepEqual(shuffleTailFromCurrent(one, 0), one);
  const two = [track("A"), track("B")];
  assert.deepEqual(shuffleTailFromCurrent(two, 0), two);
  // Indice oltre la fine: la coda resta com'e' invece di sparire.
  const three = [track("A"), track("B"), track("C")];
  assert.deepEqual(shuffleTailFromCurrent(three, 99), three);
});

test("i brani bloccati non entrano nelle code generate", () => {
  const blocked = track("A");
  const pool = [blocked, track("B"), track("C")];
  const out = filterPoolForExclusions(pool, pool[1], {
    respectExclusions: true,
    isExcluded: (t) => t.rel_path === blocked.rel_path,
  });
  assert.equal(out.length, 2);
  assert.ok(!out.includes(blocked));
});

test("partire da un brano bloccato e' una scelta: allora entrano tutti", () => {
  const blocked = track("A");
  const pool = [blocked, track("B"), track("C")];
  const out = filterPoolForExclusions(pool, blocked, {
    respectExclusions: true,
    isExcluded: (t) => t.rel_path === blocked.rel_path,
  });
  assert.equal(out.length, 3);
});

test("senza la regola attiva i bloccati restano dentro", () => {
  const pool = [track("A"), track("B")];
  assert.equal(filterPoolForExclusions(pool, null, { isExcluded: () => true }).length, 2);
  assert.equal(filterPoolForExclusions(pool, null).length, 2);
});

test("la somiglianza pesa il genere, e l'artista solo per un soffio", () => {
  const seed = track("Skrillex", "Dubstep");
  const sameGenre = track("Zomboy", "Dubstep");
  const sameArtist = track("Skrillex", "Ambient");
  const nothing = track("Bach", "Classica");
  assert.equal(seedSimilarityScore(seed, sameGenre), 1);
  assert.equal(seedSimilarityScore(seed, sameArtist), 0.05);
  assert.equal(seedSimilarityScore(seed, nothing), 0);
  assert.ok(
    seedSimilarityScore(seed, sameGenre) > seedSimilarityScore(seed, sameArtist),
  );
});

test("brano senza genere: nessuna somiglianza da inventare", () => {
  const seed = track("Skrillex", null);
  assert.equal(seedSimilarityScore(seed, track("Zomboy", "Dubstep")), 0);
});

test("la casuale intelligente stacca i brani dello stesso artista", () => {
  const pool = [
    track("A"), track("A"), track("A"),
    track("B"), track("B"), track("B"),
  ];
  for (let i = 0; i < 30; i += 1) {
    const out = buildSmartRandomQueue(pool);
    assert.deepEqual(paths(out), paths(pool));
    assert.equal(adjacentSameArtist(out), 0);
  }
});

test("non si riparte dal brano che sta suonando", () => {
  const current = track("A");
  const pool = [current, track("B"), track("C"), track("D")];
  for (let i = 0; i < 30; i += 1) {
    const out = buildSmartRandomQueue(pool, {
      currentRelPath: current.rel_path,
      currentArtist: current.artist_name,
    });
    assert.notEqual(out[0].rel_path, current.rel_path);
  }
});

test("quello che si e' appena sentito finisce in fondo", () => {
  const recent = track("A");
  const pool = [recent, track("B"), track("C")];
  const out = buildSmartRandomQueue(pool, {
    recentRelPaths: new Set([recent.rel_path]),
  });
  assert.equal(out.at(-1).rel_path, recent.rel_path);
});

test("coda da una card: il brano scelto suona per primo, una volta sola", () => {
  const seed = track("A", "Dubstep");
  const pool = [seed, track("B", "Dubstep"), track("C"), track("D")];
  const out = buildShuffleQueueFromSeed(seed, pool);
  assert.equal(out[0].rel_path, seed.rel_path);
  assert.equal(out.filter((t) => t.rel_path === seed.rel_path).length, 1);
  assert.equal(out.length, pool.length);
});

test("un brano solo nel pool: la coda e' quel brano", () => {
  const seed = track("A");
  assert.deepEqual(buildShuffleQueueFromSeed(seed, [seed]), [seed]);
});

test("la coda da card non supera il tetto", () => {
  const seed = track("Seed", "Dubstep");
  const pool = [seed, ...Array.from({ length: 700 }, () => track("Tanti", "Dubstep"))];
  const out = buildShuffleQueueFromSeed(seed, pool);
  assert.equal(out.length, CARD_QUEUE_CAP);
  assert.equal(out[0].rel_path, seed.rel_path);
});

test("radio: dopo il seed viene il brano piu' somigliante", () => {
  const seed = track("Skrillex", "Dubstep");
  const library = [seed, track("Bach", "Classica"), track("Zomboy", "Dubstep")];
  const out = buildRadioFromSeed(seed, library);
  assert.equal(out[0].rel_path, seed.rel_path);
  assert.equal(out[1].artist_name, "Zomboy");
});

test("radio: la lunghezza chiesta si rispetta, tetto compreso", () => {
  const seed = track("Skrillex", "Dubstep");
  const library = [seed, ...Array.from({ length: 40 }, () => track("Vari", "Dubstep"))];
  assert.equal(buildRadioFromSeed(seed, library, { maxLength: 10 }).length, 10);
  assert.equal(buildRadioFromSeed(seed, library, { maxLength: 0 }).length, 1);
  assert.equal(
    buildRadioFromSeed(seed, library, { maxLength: 9999 }).length,
    library.length,
  );
});

test("radio: i bloccati restano fuori anche qui", () => {
  const seed = track("Skrillex", "Dubstep");
  const blocked = track("Zomboy", "Dubstep");
  const out = buildRadioFromSeed(seed, [seed, blocked, track("Bach", "Classica")], {
    respectExclusions: true,
    isExcluded: (t) => t.rel_path === blocked.rel_path,
  });
  assert.equal(out.length, 2);
  assert.ok(!out.some((t) => t.rel_path === blocked.rel_path));
});
