/**
 * Campo `genre`: scritto con "; " ma letto anche negli stili vecchi ("a/b", "a, b").
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTrackGenresForDisplay,
  parseTrackGenres,
  serializeTrackGenres,
  trackHasGenre,
} from "./genres.ts";

test("niente genere: lista vuota, non una lista con la stringa vuota", () => {
  assert.deepEqual(parseTrackGenres(null), []);
  assert.deepEqual(parseTrackGenres(undefined), []);
  assert.deepEqual(parseTrackGenres("   "), []);
});

test("i tre separatori che girano nei tag: ';', '/' e ','", () => {
  assert.deepEqual(parseTrackGenres("Techno; Acid"), ["Techno", "Acid"]);
  assert.deepEqual(parseTrackGenres("Techno / Acid"), ["Techno", "Acid"]);
  assert.deepEqual(parseTrackGenres("Techno, Acid"), ["Techno", "Acid"]);
  assert.deepEqual(parseTrackGenres("Techno; Acid / Dub, Ambient"), [
    "Techno",
    "Acid",
    "Dub",
    "Ambient",
  ]);
});

test("doppioni via senza guardare le maiuscole, e resta la prima grafia", () => {
  assert.deepEqual(parseTrackGenres("Techno; techno; TECHNO"), ["Techno"]);
});

test("serializzare: forma canonica, e null quando non c'e' niente da salvare", () => {
  assert.equal(serializeTrackGenres(["Techno", "Acid"]), "Techno; Acid");
  assert.equal(serializeTrackGenres(["Techno", "techno"]), "Techno");
  assert.equal(serializeTrackGenres([]), null);
  assert.equal(serializeTrackGenres(null), null);
  assert.equal(serializeTrackGenres(["  ", ""]), null);
});

test("un giro di andata e ritorno non cambia il campo", () => {
  const raw = "Drum & Bass; Jungle";
  assert.equal(serializeTrackGenres(parseTrackGenres(raw)), raw);
});

test("il filtro per genere ignora maiuscole e spazi", () => {
  assert.equal(trackHasGenre("Techno; Acid", "acid"), true);
  assert.equal(trackHasGenre("Techno; Acid", "  TECHNO "), true);
  assert.equal(trackHasGenre("Techno; Acid", "house"), false);
  // Un token vuoto non deve pescare tutta la libreria.
  assert.equal(trackHasGenre("Techno", "  "), false);
});

test("a schermo i generi si separano col punto in mezzo", () => {
  assert.equal(formatTrackGenresForDisplay("Techno; Acid"), "Techno · Acid");
  assert.equal(formatTrackGenresForDisplay(null), "");
});
