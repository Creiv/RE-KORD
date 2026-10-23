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

test("strongWords funziona con alfabeti non latini (issue #100)", () => {
  assert.deepEqual(strongWords("Подмосковные вечера"), ["ПОДМОСКОВНЫЕ", "ВЕЧЕРА"]);
  assert.deepEqual(strongWords("Το τραγούδι της βροχής"), ["ΤΡΑΓΟΎΔΙ", "ΒΡΟΧΉΣ"]);
  assert.deepEqual(strongWords("أغنية الليل الطويل"), ["الطويل", "أغنية"]);
  assert.deepEqual(strongWords("桜が 咲いた 春の日に"), ["春の日に", "咲いた"]);
  assert.deepEqual(strongWords("사랑해요 그대"), ["사랑해요", "그대"]);
});

test("planLine: stessa riga, stessa composizione; righe vuote senza parole", () => {
  const a = planLine("Sparare alla luna per dormire 'sta notte");
  assert.deepEqual(planLine("Sparare alla luna per dormire 'sta notte"), a);
  assert.ok(a.words.length >= 1);
  assert.deepEqual(planLine("").words, []);
  const stack = ["Quand'ero nel bosco e in prigione", "Ascolto le loro lamentazioni"].map(planLine);
  for (const p of stack) if (p.layout === "stack") assert.equal(p.words.length, 2);
});
