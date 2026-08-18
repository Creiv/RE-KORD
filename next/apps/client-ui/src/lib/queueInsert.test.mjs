/**
 * "Aggiungi in coda": dove finisce il brano appena messo in fila.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeQueueInsertIndex, insertTracksInQueue } from "./queueInsert.ts";

const queue = ["a", "b", "c", "d"].map((rel_path) => ({ rel_path }));

const opts = (over = {}) => ({
  currentRelPath: null,
  currentIndex: -1,
  crossfadeBusy: false,
  crossfadeNextIndex: null,
  manualQueuedPaths: new Set(),
  ...over,
});

test("subito dopo il brano corrente", () => {
  const at = computeQueueInsertIndex(queue, opts({ currentRelPath: "b", currentIndex: 1 }));
  assert.equal(at, 2);
});

test("il percorso vince sull'indice: la coda si e' mossa sotto i piedi", () => {
  // L'indice dice 0, ma "c" e' in terza posizione: comanda il percorso.
  const at = computeQueueInsertIndex(queue, opts({ currentRelPath: "c", currentIndex: 0 }));
  assert.equal(at, 3);
});

test("brano corrente non piu' in coda: si ricade sull'indice", () => {
  const at = computeQueueInsertIndex(queue, opts({ currentRelPath: "zz", currentIndex: 2 }));
  assert.equal(at, 3);
});

test("coda vuota e niente in ascolto: si inserisce in testa", () => {
  assert.equal(computeQueueInsertIndex([], opts()), 0);
  assert.equal(computeQueueInsertIndex(queue, opts()), 0);
});

test("durante il crossfade conta il brano che sta entrando", () => {
  const at = computeQueueInsertIndex(
    queue,
    opts({
      currentRelPath: "a",
      currentIndex: 0,
      crossfadeBusy: true,
      crossfadeNextIndex: 2,
    }),
  );
  assert.equal(at, 3);
});

test("i brani messi in coda a mano non si scavalcano fra loro", () => {
  const at = computeQueueInsertIndex(
    queue,
    opts({
      currentRelPath: "a",
      currentIndex: 0,
      manualQueuedPaths: new Set(["b", "c"]),
    }),
  );
  assert.equal(at, 3);
});

test("se i manuali arrivano in fondo alla coda si inserisce in fondo", () => {
  const at = computeQueueInsertIndex(
    queue,
    opts({
      currentRelPath: "a",
      currentIndex: 0,
      manualQueuedPaths: new Set(["b", "c", "d"]),
    }),
  );
  assert.equal(at, queue.length);
});

test("un indice fuori scala non esce dalla coda", () => {
  assert.equal(computeQueueInsertIndex(queue, opts({ currentIndex: 99 })), 4);
  assert.equal(computeQueueInsertIndex(queue, opts({ currentIndex: -50 })), 0);
});

test("l'inserimento non tocca l'ordine di quello che c'era", () => {
  const out = insertTracksInQueue(queue, [{ rel_path: "x" }, { rel_path: "y" }], 2);
  assert.deepEqual(out.map((t) => t.rel_path), ["a", "b", "x", "y", "c", "d"]);
  // La coda di partenza resta com'era: chi chiama tiene il suo array.
  assert.deepEqual(queue.map((t) => t.rel_path), ["a", "b", "c", "d"]);
});

test("inserire oltre la fine (o prima dell'inizio) non perde brani", () => {
  const tail = insertTracksInQueue(queue, [{ rel_path: "x" }], 99);
  assert.deepEqual(tail.at(-1).rel_path, "x");
  const head = insertTracksInQueue(queue, [{ rel_path: "x" }], -3);
  assert.equal(head[0].rel_path, "x");
  assert.equal(head.length, queue.length + 1);
});
