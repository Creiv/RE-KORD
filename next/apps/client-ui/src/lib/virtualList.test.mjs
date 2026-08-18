/**
 * Geometry checks for the row windowing used by tracklists and the queue.
 * Imports the real module: run with `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { windowRange } from "./virtualWindow.ts";

const base = {
  count: 500,
  rowPx: 76,
  gapPx: 14,
  overscan: 8,
  viewHeight: 900,
};

test("top of the list starts at row 0 with no padding above", () => {
  const win = windowRange({ ...base, scrolledBy: -120 });
  assert.equal(win.start, 0);
  assert.equal(win.padTop, 0);
  assert.ok(win.end >= Math.ceil(base.viewHeight / base.rowPx));
});

test("padding stands in for the rows that are not rendered", () => {
  const win = windowRange({ ...base, scrolledBy: 10_000 });
  assert.equal(win.padTop, win.start * base.rowPx);
  assert.equal(
    win.padBottom,
    (base.count - win.end) * base.rowPx - base.gapPx,
    "the last rendered row is followed by a flex gap, the padding is not",
  );
});

test("the end of the list renders to the last row without trailing padding", () => {
  const win = windowRange({ ...base, scrolledBy: base.count * base.rowPx });
  assert.equal(win.end, base.count);
  assert.equal(win.padBottom, 0);
});

test("every row inside the viewport is rendered, at any scroll offset", () => {
  const total = base.count * base.rowPx;
  for (let scrolledBy = -200; scrolledBy <= total; scrolledBy += 137) {
    const win = windowRange({ ...base, scrolledBy });
    const firstVisible = Math.max(0, Math.floor(scrolledBy / base.rowPx));
    const lastVisible = Math.min(
      base.count - 1,
      Math.floor((scrolledBy + base.viewHeight) / base.rowPx),
    );
    assert.ok(win.start >= 0 && win.end <= base.count, `bounds at ${scrolledBy}`);
    assert.ok(win.start <= firstVisible, `covers top at ${scrolledBy}`);
    assert.ok(win.end > lastVisible, `covers bottom at ${scrolledBy}`);
  }
});

test("a pinned row stays rendered even when far off screen", () => {
  const win = windowRange({ ...base, scrolledBy: 0, pin: 400 });
  assert.ok(win.start <= 392);
  assert.ok(win.end > 400);
  const ignored = windowRange({ ...base, scrolledBy: 0, pin: 900 });
  assert.ok(ignored.end < base.count, "out-of-range pins are ignored");
});

test("short lists are rendered whole", () => {
  const win = windowRange({ ...base, count: 12, scrolledBy: 0 });
  assert.equal(win.start, 0);
  assert.equal(win.end, 12);
  assert.equal(win.padTop, 0);
  assert.equal(win.padBottom, 0);
});
