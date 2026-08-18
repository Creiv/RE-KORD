/**
 * Soglie del gesto sulla barra del player.
 * Imports the real module: run with `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SWIPE_ACTIVATE_PX,
  SWIPE_MAX_VERTICAL_PX,
  SWIPE_THRESHOLD_PX,
  createSwipeGesture,
} from "./playerSwipe.ts";

test("uno spostamento corto non cambia brano", () => {
  const g = createSwipeGesture();
  g.begin(200, 100);
  assert.equal(g.move(200 + SWIPE_ACTIVATE_PX - 1, 100), "idle");
  assert.equal(g.move(200 + SWIPE_THRESHOLD_PX - 1, 100), "capture");
  assert.equal(g.move(200 + SWIPE_THRESHOLD_PX - 1, 100), "idle");
  assert.equal(g.fired, false);
});

test("trascinando a sinistra si passa al successivo, a destra al precedente", () => {
  const next = createSwipeGesture();
  next.begin(300, 100);
  assert.equal(next.move(300 - SWIPE_ACTIVATE_PX - 1, 100), "capture");
  assert.equal(next.move(300 - SWIPE_THRESHOLD_PX, 100), "next");
  assert.equal(next.fired, true);

  const prev = createSwipeGesture();
  prev.begin(300, 100);
  assert.equal(prev.move(300 + SWIPE_ACTIVATE_PX + 1, 100), "capture");
  assert.equal(prev.move(300 + SWIPE_THRESHOLD_PX, 100), "prev");
});

test("il brano cambia una volta sola per gesto", () => {
  const g = createSwipeGesture();
  g.begin(300, 100);
  g.move(300 - SWIPE_ACTIVATE_PX - 1, 100);
  assert.equal(g.move(100, 100), "next");
  assert.equal(g.move(20, 100), "idle");
  assert.equal(g.end(20, 100), "none");
});

test("un movimento in prevalenza verticale resta uno scroll", () => {
  const g = createSwipeGesture();
  g.begin(200, 300);
  assert.equal(g.move(210, 320), "idle");
  assert.equal(g.move(260, 300 + SWIPE_MAX_VERTICAL_PX + 1), "cancel");
  assert.equal(g.move(400, 300), "idle", "dopo il cancel il gesto è chiuso");
});

test("un tocco fermo apre Ascolta, un trascinamento no", () => {
  const tap = createSwipeGesture();
  tap.begin(200, 100);
  assert.equal(tap.move(203, 102), "idle");
  assert.equal(tap.end(203, 102), "tap");

  const drag = createSwipeGesture();
  drag.begin(200, 100);
  drag.move(200 + SWIPE_ACTIVATE_PX + 1, 100);
  assert.equal(drag.end(200 + SWIPE_ACTIVATE_PX + 1, 100), "none");
});

test("il pointer capture parte solo quando il gesto è orizzontale", () => {
  const g = createSwipeGesture();
  g.begin(200, 100);
  assert.equal(
    g.move(200 + SWIPE_ACTIVATE_PX + 4, 100 + SWIPE_ACTIVATE_PX + 8),
    "idle",
  );
  assert.equal(g.capturing, false);
  assert.equal(g.move(200 + SWIPE_ACTIVATE_PX + 20, 100 + 4), "capture");
  assert.equal(g.capturing, true);
});
