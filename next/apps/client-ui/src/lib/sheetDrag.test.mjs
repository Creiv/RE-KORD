/**
 * Soglie del trascinamento del foglio dal basso.
 * Il modulo vive in @rekord/ui: qui lo importiamo dal percorso reale, così il
 * test gira col runner del client (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHEET_ACTIVATE_PX,
  SHEET_DISMISS_PX,
  SHEET_FLICK_MIN_PX,
  createSheetDragGesture,
} from "../../../../packages/ui/src/lib/sheetDrag.ts";

test("un tocco fermo non muove il foglio", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  assert.equal(g.move(400 + SHEET_ACTIVATE_PX, 40), 0);
  assert.equal(g.isDragging(), false);
  assert.equal(g.end(400 + SHEET_ACTIVATE_PX, 60).dismiss, false);
});

test("oltre la soglia di attivazione il foglio segue il dito", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  assert.equal(g.move(430, 60), 30);
  assert.equal(g.isDragging(), true);
});

test("tirando verso l'alto il foglio resta al suo posto", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  g.move(430, 60);
  assert.equal(g.move(360, 120), 0);
});

test("uno spostamento lungo e lento chiude comunque", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  g.move(400 + SHEET_DISMISS_PX, 900);
  assert.equal(g.end(400 + SHEET_DISMISS_PX, 1000).dismiss, true);
});

test("uno spostamento corto e lento riporta il foglio a posto", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  g.move(440, 300);
  assert.equal(g.end(440, 400).dismiss, false);
});

test("uno strappo veloce chiude prima della soglia", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  const y = 400 + SHEET_FLICK_MIN_PX + 6;
  g.move(y, 30);
  assert.equal(g.end(y, 40).dismiss, true);
});

test("un colpetto di pochi pixel resta un tocco anche se veloce", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  const y = 400 + SHEET_FLICK_MIN_PX - 4;
  g.move(y, 10);
  assert.equal(g.end(y, 12).dismiss, false);
});

test("annullato il gesto (dito uscito, chiamata in arrivo) non chiude", () => {
  const g = createSheetDragGesture();
  g.start(400, 0);
  g.move(400 + SHEET_DISMISS_PX, 200);
  g.cancel();
  assert.equal(g.end(400 + SHEET_DISMISS_PX, 220).dismiss, false);
  assert.equal(g.isDragging(), false);
});
