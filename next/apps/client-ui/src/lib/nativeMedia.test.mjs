/**
 * Ponte verso la notifica media del guscio Android.
 * Il finto `window.RekordMediaNative` prende il posto del lato Kotlin: qui si
 * controlla cosa attraversa il ponte, e quante volte.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const calls = [];
const bridge = {
  update: (json) => calls.push(["update", JSON.parse(json)]),
  stop: () => calls.push(["stop", null]),
};
globalThis.window = { RekordMediaNative: bridge };

const { pushNativeMetadata, pushNativePlaybackState, pushNativePosition } =
  await import("./nativeMedia.ts");

/** Il ponte accumula per 80 ms: si aspetta che si svuoti. */
const settle = () => new Promise((r) => setTimeout(r, 160));

const track = { title: "Bangarang", artist: "Skrillex", album: "Bangarang EP" };

test("metadati, stato e posizione arrivano in un solo passaggio", async () => {
  calls.length = 0;
  pushNativeMetadata(track, "http://192.168.1.20:7420/api/v1/covers/album/3?size=256");
  pushNativePlaybackState("playing");
  pushNativePosition(215.4, 12.2);
  await settle();
  assert.equal(calls.length, 1);
  const [kind, state] = calls[0];
  assert.equal(kind, "update");
  assert.equal(state.title, "Bangarang");
  assert.equal(state.artist, "Skrillex");
  assert.equal(state.playing, true);
  assert.equal(state.durationMs, 215400);
  assert.equal(state.positionMs, 12200);
});

test("uno stato identico non riattraversa il ponte", async () => {
  calls.length = 0;
  pushNativePlaybackState("playing");
  await settle();
  assert.equal(calls.length, 0);
});

test("la pausa passa, e passa una volta sola", async () => {
  calls.length = 0;
  pushNativePlaybackState("paused");
  pushNativePlaybackState("paused");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].playing, false);
});

test("il brano che cambia non fa lampeggiare la notifica su 'in pausa'", async () => {
  calls.length = 0;
  pushNativePlaybackState("playing");
  await settle();
  calls.length = 0;
  // Solo i metadati: lo stato di trasporto arriva dopo, dal lettore.
  pushNativeMetadata({ title: "Rock n' Roll", artist: "Skrillex", album: "" }, "");
  await settle();
  assert.equal(calls[0][1].playing, true);
});

test("coda finita: si chiude la notifica invece di aggiornarla", async () => {
  calls.length = 0;
  pushNativePlaybackState("none");
  await settle();
  assert.deepEqual(calls, [["stop", null]]);
  // Senza brano non c'e' niente da dire: posizione e stato non fanno nulla.
  calls.length = 0;
  pushNativePosition(200, 10);
  pushNativePlaybackState("playing");
  await settle();
  assert.equal(calls.length, 0);
});

test("durata assurda: non finisce nella notifica", async () => {
  calls.length = 0;
  pushNativeMetadata(track, "");
  pushNativePosition(Number.NaN, 4);
  await settle();
  const state = calls.at(-1)[1];
  assert.equal(state.durationMs, 0);
  assert.equal(state.positionMs, 4000);
});

test("la posizione non scavalca la durata", async () => {
  calls.length = 0;
  pushNativePosition(100, 140);
  await settle();
  assert.equal(calls.at(-1)[1].positionMs, 100000);
});
