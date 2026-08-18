/**
 * Row windowing for long lists (library tracklists, playback queue).
 *
 * The action goes on the list element and reports which slice to render; the
 * rows that are not rendered are replaced by padding, so the scrollbar keeps the
 * length of the whole list. Rows are assumed to share one pitch, measured from
 * the first two rendered rows: track rows keep the title on a single line, so
 * the only real variation comes from the compact breakpoint, and re-measuring on
 * resize covers it.
 *
 * The scroller is the nearest scrolling ancestor (`<main class="content">` for
 * the views, the pane itself inside Studio), matching how drag auto-scroll finds
 * it.
 */

import { scrollParent } from "./scrollParent";
import { windowRange, type VirtualWindow } from "./virtualWindow";

export type { VirtualWindow };

export type VirtualListApi = {
  /** Brings a row into view, rendering it first if it sits outside the window. */
  scrollToIndex: (index: number, align?: "center" | "start") => void;
  /** Re-measures the row pitch, e.g. after rows gained a second line. */
  measure: () => void;
};

export type VirtualListOptions = {
  /** Length of the source list. */
  count: number;
  /** Below this many rows the whole list is rendered. */
  threshold?: number;
  /** Row pitch used until the first rows are measured. */
  estimateRowPx?: number;
  /** Extra rows kept rendered above and below the viewport. */
  overscan?: number;
  /** Freeze the window; used while a row is being dragged. */
  frozen?: boolean;
  onwindow: (window: VirtualWindow) => void;
  onready?: (api: VirtualListApi) => void;
};

const DEFAULT_THRESHOLD = 40;
const DEFAULT_ROW_PX = 68;
const DEFAULT_OVERSCAN = 8;

export function virtualList(node: HTMLElement, options: VirtualListOptions) {
  let opts = options;
  let scroller: HTMLElement | null = null;
  let rowPx = opts.estimateRowPx ?? DEFAULT_ROW_PX;
  let gapPx = 0;
  let measured = false;
  let frame = 0;
  let last: VirtualWindow | null = null;
  let pending: number | null = null;
  let pendingAlign: "center" | "start" = "center";

  const threshold = () => opts.threshold ?? DEFAULT_THRESHOLD;
  const overscan = () => opts.overscan ?? DEFAULT_OVERSCAN;
  const windowing = () => opts.count >= threshold();

  function rows(): HTMLElement[] {
    return Array.from(node.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
  }

  function measure() {
    const list = rows();
    if (list.length === 0) return;
    gapPx = Number.parseFloat(getComputedStyle(node).rowGap) || 0;
    let pitch = 0;
    if (list.length > 1) {
      const a = list[0]!.getBoundingClientRect().top;
      const b = list[1]!.getBoundingClientRect().top;
      pitch = Math.abs(b - a);
    }
    if (pitch < 8) {
      const height = list[0]!.getBoundingClientRect().height;
      pitch = height > 8 ? height + gapPx : 0;
    }
    if (pitch < 8) return;
    const changed = Math.abs(pitch - rowPx) > 0.5;
    rowPx = pitch;
    measured = true;
    if (changed) publish();
  }

  /** Viewport in scroller coordinates, plus the list origin inside it. */
  function geometry(): { viewTop: number; viewHeight: number; listTop: number } {
    const box = node.getBoundingClientRect();
    if (scroller) {
      const view = scroller.getBoundingClientRect();
      return {
        viewTop: scroller.scrollTop,
        viewHeight: scroller.clientHeight,
        listTop: scroller.scrollTop + (box.top - view.top),
      };
    }
    return {
      viewTop: window.scrollY,
      viewHeight: window.innerHeight,
      listTop: box.top + window.scrollY,
    };
  }

  function compute(): VirtualWindow {
    const count = opts.count;
    if (!windowing()) {
      return { start: 0, end: count, padTop: 0, padBottom: 0, rowPx };
    }
    const { viewTop, viewHeight, listTop } = geometry();
    // Rows are laid out as if every one were `rowPx` tall, so row i always sits
    // at listTop + i * rowPx regardless of the padding currently applied.
    return windowRange({
      count,
      rowPx,
      gapPx,
      overscan: overscan(),
      scrolledBy: viewTop - listTop,
      viewHeight,
      pin: pending,
    });
  }

  function publish() {
    const next = compute();
    if (
      last &&
      last.start === next.start &&
      last.end === next.end &&
      Math.abs(last.padTop - next.padTop) < 0.5 &&
      Math.abs(last.padBottom - next.padBottom) < 0.5
    ) {
      return;
    }
    last = next;
    opts.onwindow(next);
  }

  function schedule() {
    if (opts.frozen || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (opts.frozen) return;
      // The scroller may only start scrolling once the padding is in place, and
      // `scrollParent` skips ancestors that do not overflow yet.
      if (!scroller) attachScroller();
      publish();
      if (!measured) measure();
    });
  }

  function attachScroller() {
    const next = scrollParent(node);
    if (next === scroller) return;
    detachScroller();
    scroller = next;
    scroller?.addEventListener("scroll", schedule, { passive: true });
    viewObserver.disconnect();
    if (scroller) viewObserver.observe(scroller);
  }

  function detachScroller() {
    scroller?.removeEventListener("scroll", schedule);
  }

  const viewObserver = new ResizeObserver(() => schedule());
  /** Only width matters: the padding we apply changes the height every frame. */
  let listWidth = 0;
  const listObserver = new ResizeObserver(() => {
    const width = node.getBoundingClientRect().width;
    if (Math.abs(width - listWidth) < 0.5) return;
    listWidth = width;
    measure();
    schedule();
  });

  function scrollToIndex(index: number, align: "center" | "start" = "center") {
    if (index < 0 || index >= opts.count) return;
    if (!windowing()) {
      rows()[index]?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    pending = index;
    pendingAlign = align;
    publish();
    // The row may need a frame to mount before the scroll lands on it.
    requestAnimationFrame(() => {
      const { viewHeight, listTop } = geometry();
      const rowTop = listTop + index * rowPx;
      const top =
        pendingAlign === "start"
          ? rowTop
          : rowTop - Math.max(0, (viewHeight - rowPx) / 2);
      if (scroller) scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      else window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      pending = null;
      schedule();
    });
  }

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  listObserver.observe(node);
  attachScroller();
  publish();
  requestAnimationFrame(() => {
    measure();
    schedule();
  });
  opts.onready?.({ scrollToIndex, measure });

  return {
    update(next: VirtualListOptions) {
      const countChanged = next.count !== opts.count;
      const unfrozen = opts.frozen && !next.frozen;
      opts = next;
      if (countChanged || unfrozen) {
        attachScroller();
        schedule();
      }
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      detachScroller();
      viewObserver.disconnect();
      listObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    },
  };
}
