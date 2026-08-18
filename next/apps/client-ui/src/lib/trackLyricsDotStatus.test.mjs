/**
 * Pallino Auto LRC accanto al brano: che colore mostra e quando.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTrackLyricsDotStatus } from "./trackLyricsDotStatus.ts";

test("mentre cerca, il pallino dice solo che sta cercando", () => {
  const status = resolveTrackLyricsDotStatus({
    fetchBusy: true,
    lyricsText: "[00:12.00] riga",
    ephemeralAutoStatus: "error",
  });
  assert.equal(status, "busy");
});

test("testo con marche di tempo: sincronizzato", () => {
  assert.equal(
    resolveTrackLyricsDotStatus({ lyricsText: "[00:12.00] prima riga" }),
    "okLrc",
  );
  // Anche una sola marca in mezzo al testo basta a chiamarlo LRC.
  assert.equal(
    resolveTrackLyricsDotStatus({ lyricsText: "intro\n[1:02] ritornello" }),
    "okLrc",
  );
});

test("testo senza marche: testo semplice", () => {
  assert.equal(resolveTrackLyricsDotStatus({ lyricsText: "prima riga" }), "okPlain");
});

test("il testo salvato batte l'esito dell'ultima ricerca", () => {
  const status = resolveTrackLyricsDotStatus({
    lyricsText: "prima riga",
    ephemeralAutoStatus: "missing",
  });
  assert.equal(status, "okPlain");
});

test("senza testo si racconta com'e' andata la ricerca", () => {
  assert.equal(
    resolveTrackLyricsDotStatus({ lyricsText: "", ephemeralAutoStatus: "error" }),
    "error",
  );
  assert.equal(
    resolveTrackLyricsDotStatus({ lyricsText: "   ", ephemeralAutoStatus: "missing" }),
    "missing",
  );
});

test("brano mai toccato: pallino spento", () => {
  assert.equal(resolveTrackLyricsDotStatus({}), "idle");
  assert.equal(resolveTrackLyricsDotStatus({ lyricsText: null }), "idle");
  assert.equal(
    resolveTrackLyricsDotStatus({ lyricsText: "", ephemeralAutoStatus: "idle" }),
    "idle",
  );
});
