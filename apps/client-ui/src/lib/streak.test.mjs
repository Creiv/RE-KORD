/**
 * Streak di ascolto: unione tra la copia locale e quella sincronizzata
 * (issue #100: lo streak si azzerava a ogni aggiornamento dell'app).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStreakStates, normalizeStreakState } from "./achievements.ts";

test("normalizeStreakState scarta valori rotti", () => {
  assert.deepEqual(normalizeStreakState(null), { count: 0, lastDate: "" });
  assert.deepEqual(normalizeStreakState({ count: -3, lastDate: "ieri" }), { count: 0, lastDate: "" });
  assert.deepEqual(normalizeStreakState({ count: 4.7, lastDate: "2026-10-23" }), { count: 4, lastDate: "2026-10-23" });
});

test("mergeStreakStates: giorno più recente, conteggio più alto, giorni consecutivi si sommano", () => {
  const none = { count: 0, lastDate: "" };
  const phone = { count: 3, lastDate: "2026-10-22" };
  const desktop = { count: 1, lastDate: "2026-10-23" };
  assert.deepEqual(mergeStreakStates(none, phone), phone);
  assert.deepEqual(mergeStreakStates(phone, none), phone);
  // Ieri sul telefono (3), oggi sul desktop (1): streak di 4.
  assert.deepEqual(mergeStreakStates(phone, desktop), { count: 4, lastDate: "2026-10-23" });
  assert.deepEqual(mergeStreakStates(desktop, phone), { count: 4, lastDate: "2026-10-23" });
  // Stesso giorno: vince il conteggio più alto.
  assert.deepEqual(mergeStreakStates({ count: 2, lastDate: "2026-10-23" }, desktop), { count: 2, lastDate: "2026-10-23" });
  // Un buco di due giorni: vale solo la copia più recente.
  assert.deepEqual(mergeStreakStates({ count: 9, lastDate: "2026-10-20" }, desktop), desktop);
  // Cambio di mese e di anno.
  assert.deepEqual(mergeStreakStates({ count: 5, lastDate: "2025-12-31" }, { count: 1, lastDate: "2026-01-01" }), { count: 6, lastDate: "2026-01-01" });
});
