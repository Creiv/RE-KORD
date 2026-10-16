/**
 * Sfondo del karaoke: parole forti di una riga e composizione.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineWords, planLine, strongWords } from "./visualizer/karaokeWords.ts";

test("lineWords toglie punteggiatura, cori tra parentesi ed elisioni", () => {
  assert.deepEqual(lineWords("Non servirà (ho sentito gli spari), non basterà"), ["Non", "servirà", "non", "basterà"]);
  assert.deepEqual(lineWords("Mi giro dall'altra parte"), ["Mi", "giro", "altra", "parte"]);
});

test("strongWords sceglie le parole piene, la più forte per prima", () => {
  assert.deepEqual(strongWords("Un silenzio del genere"), ["SILENZIO", "GENERE"]);
  // A parità di lunghezza vince la parola in fondo alla riga.
  assert.deepEqual(strongWords("Non c'è manto erboso ma cenere", 1), ["CENERE"]);
  assert.deepEqual(strongWords("oh oh yeah"), []);
  assert.deepEqual(strongWords("Pare che sia io che non glie ne dia"), []);
});

test("planLine: stessa riga, stessa composizione; righe vuote senza parole", () => {
  const a = planLine("Sparare alla luna per dormire 'sta notte");
  assert.deepEqual(planLine("Sparare alla luna per dormire 'sta notte"), a);
  assert.ok(a.words.length >= 1);
  assert.deepEqual(planLine("").words, []);
  const stack = ["Quand'ero nel bosco e in prigione", "Ascolto le loro lamentazioni"].map(planLine);
  for (const p of stack) if (p.layout === "stack") assert.equal(p.words.length, 2);
});
