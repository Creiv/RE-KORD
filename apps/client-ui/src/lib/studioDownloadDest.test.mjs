/**
 * Destinazione dei download dello Studio: dove finiscono i file e cosa si chiede
 * prima di scriverli. La domanda di conferma cambia tono quando si sta per
 * riversare dei brani dentro la cartella di un artista.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildStudioDownloadConfirm,
  isValidDownloadDestPath,
  joinMusicDestRelPath,
  normalizeDownloadDestPath,
  relPathLooksLikeAlbumFolderDest,
  resolveStudioDownloadOutputDir,
  studioDownloadKindForScope,
} from "./studioDownloadDest.ts";

/** Il messaggio arriva dalla tabella italiana vera, come nell'app. */
const IT = JSON.parse(
  readFileSync(new URL("../locales/studio/it.json", import.meta.url), "utf8"),
);
const tr = (key, vars = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v)), IT[key] ?? key);

test("il percorso si normalizza: barre di Windows, barre in testa e in coda", () => {
  assert.equal(normalizeDownloadDestPath("\\Skrillex\\Bangarang\\"), "Skrillex/Bangarang");
  assert.equal(normalizeDownloadDestPath("///Skrillex///"), "Skrillex");
  assert.equal(normalizeDownloadDestPath(null), "");
  assert.equal(normalizeDownloadDestPath("   "), "");
});

test("senza percorso non si scarica", () => {
  assert.equal(isValidDownloadDestPath("Skrillex"), true);
  assert.equal(isValidDownloadDestPath("/"), false);
  assert.equal(isValidDownloadDestPath(undefined), false);
});

test("una cartella album ha almeno due livelli: artista e disco", () => {
  assert.equal(relPathLooksLikeAlbumFolderDest("Skrillex"), false);
  assert.equal(relPathLooksLikeAlbumFolderDest("Skrillex/Bangarang"), true);
  assert.equal(relPathLooksLikeAlbumFolderDest(""), false);
});

test("il titolo non puo' aprire cartelle sue", () => {
  assert.equal(joinMusicDestRelPath("Skrillex", "Bangarang EP"), "Skrillex/Bangarang EP");
  // Le barre nel titolo diventano spazi: "AC/DC" non deve creare un livello.
  assert.equal(joinMusicDestRelPath("Live", "AC/DC Live"), "Live/AC DC Live");
  assert.equal(joinMusicDestRelPath("", "Bangarang"), "Bangarang");
  assert.equal(joinMusicDestRelPath("Skrillex", "   "), "Skrillex");
});

test("un album scelto su cartella artista si prende una sottocartella col suo nome", () => {
  assert.equal(
    resolveStudioDownloadOutputDir("Skrillex", "playlist", "Bangarang EP"),
    "Skrillex/Bangarang EP",
  );
});

test("se la destinazione e' gia' una cartella album si scrive dentro quella", () => {
  assert.equal(
    resolveStudioDownloadOutputDir("Skrillex/Bangarang", "playlist", "Bangarang EP"),
    "Skrillex/Bangarang",
  );
});

test("un singolo va dove gli e' stato detto, senza sottocartelle", () => {
  assert.equal(resolveStudioDownloadOutputDir("Skrillex", "single", "Rock n' Roll"), "Skrillex");
  assert.equal(
    resolveStudioDownloadOutputDir("Skrillex/Bangarang", "single"),
    "Skrillex/Bangarang",
  );
});

test("scaricare in cartella artista e' l'avviso forte", () => {
  const c = buildStudioDownloadConfirm({ dlPath: "Skrillex", scope: "single" }, tr);
  assert.equal(c.variant, "danger");
  assert.match(c.message, /cartella artista «Skrillex»/);
});

test("in una cartella album basta la conferma normale", () => {
  const c = buildStudioDownloadConfirm({ dlPath: "Skrillex/Bangarang", scope: "single" }, tr);
  assert.equal(c.variant, "warning");
  assert.match(c.message, /«Skrillex\/Bangarang»/);
  assert.doesNotMatch(c.message, /cartella artista/);
  assert.match(c.message, /^Scaricare il brano in/, "a single is one track");
});

test("per l'album conta la cartella dove si finisce, non quella scelta", () => {
  const c = buildStudioDownloadConfirm({
    dlPath: "Skrillex",
    scope: "playlist",
    releaseTitle: "Bangarang EP",
    trackCount: 7,
  }, tr);
  assert.equal(c.variant, "warning");
  assert.match(c.message, /«Skrillex\/Bangarang EP»/);
  assert.match(c.message, /Scaricare i brani in/);
  assert.match(c.message, /Brani previsti: 7\./);
});

test("album senza titolo su cartella artista: torna l'avviso forte", () => {
  const c = buildStudioDownloadConfirm({ dlPath: "Skrillex", scope: "playlist" }, tr);
  assert.equal(c.variant, "danger");
});

test("il conteggio si scrive solo se c'e' davvero", () => {
  const none = buildStudioDownloadConfirm({
    dlPath: "Skrillex/Bangarang",
    scope: "playlist",
    trackCount: null,
  }, tr);
  assert.doesNotMatch(none.message, /Brani previsti/);
  const zero = buildStudioDownloadConfirm({
    dlPath: "Skrillex/Bangarang",
    scope: "playlist",
    trackCount: 0,
  }, tr);
  assert.doesNotMatch(zero.message, /Brani previsti/);
});

test("la premessa di chi chiama sta in testa, staccata", () => {
  const c = buildStudioDownloadConfirm({
    dlPath: "Skrillex/Bangarang",
    scope: "single",
    preamble: "Il brano esiste già in libreria.",
  }, tr);
  assert.ok(c.message.startsWith("Il brano esiste già in libreria.\n\n"));
});

test("il tipo di job cambia col genere di download", () => {
  assert.equal(studioDownloadKindForScope("single"), "download_single");
  assert.equal(studioDownloadKindForScope("playlist"), "download_playlist");
});
