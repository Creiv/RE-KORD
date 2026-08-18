/**
 * Geometry of a windowed list: which rows to render and how much padding stands
 * in for the ones left out. Kept free of DOM access so it can be checked on its
 * own (see virtualList.test.mjs); the action in virtualList.ts feeds it the
 * measurements.
 */

export type VirtualWindow = {
  /** First rendered index. */
  start: number;
  /** One past the last rendered index. */
  end: number;
  padTop: number;
  padBottom: number;
  /** Row height including the gap that follows it. */
  rowPx: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Which rows to render, given how far the scroller has moved past the top of
 * the list. Rows are treated as one uniform pitch, so row `i` always sits at
 * `listTop + i * rowPx` whatever padding is currently applied.
 */
export function windowRange(input: {
  count: number;
  rowPx: number;
  gapPx: number;
  overscan: number;
  /** Scroll offset relative to the top of the list; negative above it. */
  scrolledBy: number;
  viewHeight: number;
  /** Row that must stay rendered even if it is off screen. */
  pin?: number | null;
}): VirtualWindow {
  const { count, rowPx, gapPx, overscan, scrolledBy, viewHeight, pin } = input;
  const first = Math.floor(scrolledBy / rowPx);
  const visible = Math.ceil(viewHeight / rowPx);
  let start = clamp(first - overscan, 0, Math.max(0, count - 1));
  let end = clamp(start + visible + overscan * 2, 0, count);
  if (pin != null && pin >= 0 && pin < count) {
    start = Math.min(start, Math.max(0, pin - overscan));
    end = Math.max(end, Math.min(count, pin + overscan + 1));
  }
  return {
    start,
    end,
    padTop: start * rowPx,
    // The last rendered row is followed by a flex gap, the padding is not.
    padBottom: Math.max(0, (count - end) * rowPx - (end < count ? gapPx : 0)),
    rowPx,
  };
}
