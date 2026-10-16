/**
 * Campo `genre`: scritto con "; " ma letto anche negli stili vecchi ("a/b", "a, b").
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addGenresToDraft,
  countGenreLabels,
  genreDraftFromField,
  fieldHasGenreLabel,
  formatTrackGenresForDisplay,
  genreLabelChoices,
  genreLabelKey,
  parseTrackGenres,
  serializeTrackGenres,
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
  assert.equal(fieldHasGenreLabel("Techno; Acid", "acid"), true);
  assert.equal(fieldHasGenreLabel("Techno; Acid", "  TECHNO "), true);
  assert.equal(fieldHasGenreLabel("Techno; Acid", "house"), false);
  // Un token vuoto non deve pescare tutta la libreria.
  assert.equal(fieldHasGenreLabel("Techno", "  "), false);
});

test("a schermo i generi si separano col punto in mezzo", () => {
  assert.equal(formatTrackGenresForDisplay("Techno; Acid"), "Techno · Acid");
  assert.equal(formatTrackGenresForDisplay(null), "");
});

import {
  canonicalGenreLabel,
  normalizeGenreKey,
  primaryGenre,
  trackGenreKeys,
  trackGenres,
} from "./genres.ts";

test("anche '|' separa, e i numeri / segnaposto spariscono", () => {
  assert.deepEqual(parseTrackGenres("Rock | Pop; 8; (17); Music"), ["Rock", "Pop"]);
  assert.deepEqual(parseTrackGenres("Hip Hop; Pop Rap"), ["Hip Hop", "Pop Rap"]);
});

test("la chiave non guarda maiuscole, spazi, trattini e accenti (come l'hub)", () => {
  assert.equal(normalizeGenreKey("Hip Hop"), "hiphop");
  assert.equal(normalizeGenreKey("hip-hop"), "hiphop");
  assert.equal(normalizeGenreKey("HipHop"), "hiphop");
  assert.equal(normalizeGenreKey("Électro"), "electro");
  assert.deepEqual(parseTrackGenres("Hip Hop; Hip-Hop; hiphop"), ["Hip Hop"]);
});

test("etichetta canonica: grafie note, title case per il tutto minuscolo", () => {
  assert.equal(canonicalGenreLabel("hip-hop"), "Hip Hop");
  assert.equal(canonicalGenreLabel("rnb"), "R&B");
  assert.equal(canonicalGenreLabel("pop rap"), "Pop Rap");
  assert.equal(canonicalGenreLabel("Drum & Bass"), "Drum and Bass");
  assert.equal(canonicalGenreLabel("Cantautorato"), "Cantautorato");
});

test("i generi del brano: prima l'elenco dell'hub, poi il campo, poi l'album", () => {
  assert.deepEqual(trackGenres({ genre: "hip-hop; Pop Rap", genres: ["Hip Hop", "Pop Rap"] }), [
    "Hip Hop",
    "Pop Rap",
  ]);
  assert.deepEqual(trackGenres({ genre: "hip-hop / trap" }), ["Hip Hop", "Trap"]);
  assert.deepEqual(trackGenres({ genre: null }, { genre: "Rock" }), ["Rock"]);
  assert.deepEqual(trackGenreKeys({ genre: "Hip Hop; Pop Rap" }), ["hiphop", "poprap"]);
  assert.equal(primaryGenre({ genre: "" }), null);
});

// Issue #97: the album "Aggiungi genere" menu was a keyed {#each} on the label;
// "Rhythm & Blues" (library) and "R&B" (pool) are different keys with one
// label → each_key_duplicate and the library view crashed.
test("alias con la stessa etichetta: una sola voce nel menu e un solo chip", () => {
  assert.equal(genreLabelKey("Rhythm & Blues"), genreLabelKey("R&B"));
  assert.equal(genreLabelKey("Drum & Bass"), genreLabelKey("Drum and Bass"));
  const choices = genreLabelChoices(["Rhythm & Blues; Drum & Bass", "Drum and Bass", "Rock"], ["R&B", "Rock", "Jazz"], new Set());
  const labels = choices.map((c) => c.label);
  assert.deepEqual([...labels].sort(), ["Drum and Bass", "Jazz", "R&B", "Rock"]);
  assert.equal(new Set(choices.map((c) => c.key)).size, choices.length);
  assert.equal(new Set(labels).size, labels.length);
  const stats = countGenreLabels(["Rhythm & Blues; R&B", "R&B", null, "Rock"]);
  assert.deepEqual(
    stats.map((g) => [g.label, g.count]).sort(),
    [["R&B", 2], ["Rock", 1]],
  );
});

test("menu aggiungi genere: niente generi già sull'album, nemmeno come alias", () => {
  const have = new Set(countGenreLabels(["Rhythm & Blues"]).map((g) => g.key));
  const labels = genreLabelChoices(["R&B; Pop"], ["R&B", "Jazz"], have).map((c) => c.label);
  assert.deepEqual(labels.sort(), ["Jazz", "Pop"]);
  assert.ok(fieldHasGenreLabel("Rhythm & Blues; Pop", "R&B"));
  assert.ok(!fieldHasGenreLabel("Pop", "R&B"));
});

test("modifica brano: alias e doppioni diventano un chip solo, con chiavi uniche", () => {
  const draft = genreDraftFromField("R&B; Rhythm & Blues / Hip Hop, hip-hop;; ;Hip-Hop; 8; Unknown; Rock");
  assert.deepEqual(draft, ["R&B", "Hip Hop", "Rock"]);
  const keys = draft.map(genreLabelKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(draft.map(canonicalGenreLabel), ["R&B", "Hip Hop", "Rock"]);
});

test("modifica brano: liste lunghe senza chiavi doppie (la vecchia chiave g+i collideva)", () => {
  const tokens = Array.from({ length: 40 }, (_, i) => `Genre${i}`);
  // "Genre1" + 10 e "Genre11" + 0 davano la stessa chiave "Genre110".
  const draft = genreDraftFromField(tokens.join("; "));
  assert.equal(draft.length, 40);
  const keys = draft.map(genreLabelKey);
  assert.equal(new Set(keys).size, 40);
});

test("modifica brano: aggiungere un alias o un doppione non cambia la bozza", () => {
  const draft = ["Hip-Hop", "R&B"];
  assert.equal(addGenresToDraft(draft, "Hip Hop"), draft);
  assert.equal(addGenresToDraft(draft, "hiphop"), draft);
  assert.equal(addGenresToDraft(draft, "Rhythm & Blues"), draft);
  assert.equal(addGenresToDraft(draft, "  "), draft);
  assert.equal(addGenresToDraft(draft, "8"), draft);
  assert.equal(addGenresToDraft(draft, "Unknown"), draft);
});

test("modifica brano: si possono incollare più generi con qualsiasi separatore", () => {
  assert.deepEqual(addGenresToDraft(["Rock"], "Pop; Jazz / rock, Drum & Bass | Drum and Bass"), [
    "Rock",
    "Pop",
    "Jazz",
    "Drum & Bass",
  ]);
});

test("menu della modifica brano: generi della libreria, senza quelli già sul brano", () => {
  const fields = ["Rhythm & Blues; Trap", "R&B", "hip-hop", null, ""];
  const draft = ["Hip Hop"];
  const opts = genreLabelChoices(fields, ["Hip-Hop", "Rap", "R&B"], new Set(draft.map(genreLabelKey)));
  assert.deepEqual(
    opts.map((o) => o.label),
    ["R&B", "Trap", "Rap"],
  );
  assert.equal(new Set(opts.map((o) => o.key)).size, opts.length);
});

test("a schermo gli alias compaiono una volta sola (non \"R&B · R&B\")", () => {
  assert.equal(formatTrackGenresForDisplay("R&B; Rhythm & Blues; Hip-Hop; hip hop"), "R&B · Hip Hop");
});
