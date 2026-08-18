/**
 * Pointer-driven list reordering, shared by the queue and by playlists.
 *
 * The action goes on the list element; rows carry `data-reorder-index` and the
 * grip inside each row carries `data-reorder-handle`. Dragging only starts from
 * a handle, so row clicks and page scrolling keep working. Pointer events cover
 * mouse, touch and pen with one code path.
 */

import { scrollParent } from "./scrollParent";

export type DragReorderOptions = {
  /** Called once, on release, with the row indexes taken from the DOM. */
  onmove: (from: number, to: number) => void;
  enabled?: boolean;
  /**
   * True while a row is held. Windowed lists freeze on this: the cached row
   * rects would point at nodes recycled mid-drag.
   */
  ondragstate?: (dragging: boolean) => void;
};

const ROW_SELECTOR = "[data-reorder-index]";
const HANDLE_SELECTOR = "[data-reorder-handle]";
/** Distance from the edge of the scroller that starts auto-scrolling. */
const EDGE_PX = 64;
const EDGE_STEP_PX = 12;

type RowRect = { top: number; height: number };

function rowIndex(el: Element): number {
  const raw = el.getAttribute("data-reorder-index");
  const n = Number(raw);
  return Number.isFinite(n) ? n : -1;
}

export function dragReorder(node: HTMLElement, options: DragReorderOptions) {
  let opts = options;
  let rows: HTMLElement[] = [];
  let rects: RowRect[] = [];
  let step = 0;
  let from = -1;
  let target = -1;
  let startY = 0;
  let dragged: HTMLElement | null = null;
  let handle: HTMLElement | null = null;
  let pointerId = -1;
  let scroller: HTMLElement | null = null;
  /** Pixels the scroller moved since the drag started; cached rects predate it. */
  let scrollShift = 0;
  let scrollFrom = 0;
  let edgeFrame = 0;
  let edgeDelta = 0;

  function shiftFor(index: number): number {
    if (target === from) return 0;
    if (target > from && index > from && index <= target) return -step;
    if (target < from && index >= target && index < from) return step;
    return 0;
  }

  function paint(dy: number) {
    if (dragged) dragged.style.transform = `translateY(${dy}px)`;
    rows.forEach((row, i) => {
      if (i === from) return;
      const shift = shiftFor(i);
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }

  function resolveTarget(dy: number) {
    const own = rects[from];
    if (!own) return;
    const center = own.top + own.height / 2 + dy;
    let next = from;
    for (let i = 0; i < rects.length; i += 1) {
      if (i === from) continue;
      const r = rects[i]!;
      const mid = r.top + r.height / 2;
      if (i < from && center < mid) {
        next = i;
        break;
      }
      if (i > from && center > mid) next = i;
    }
    target = next;
  }

  function currentDy(clientY: number): number {
    return clientY - startY + scrollShift;
  }

  function stopEdgeScroll() {
    if (edgeFrame) cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    edgeDelta = 0;
  }

  function runEdgeScroll(clientY: number) {
    if (!edgeDelta) {
      stopEdgeScroll();
      return;
    }
    const tick = () => {
      if (from < 0 || !edgeDelta) return;
      const before = scroller ? scroller.scrollTop : window.scrollY;
      if (scroller) scroller.scrollTop = before + edgeDelta;
      else window.scrollBy(0, edgeDelta);
      const after = scroller ? scroller.scrollTop : window.scrollY;
      if (after === before) {
        stopEdgeScroll();
        return;
      }
      scrollShift = after - scrollFrom;
      const dy = currentDy(clientY);
      resolveTarget(dy);
      paint(dy);
      edgeFrame = requestAnimationFrame(tick);
    };
    if (!edgeFrame) edgeFrame = requestAnimationFrame(tick);
  }

  function updateEdgeScroll(clientY: number) {
    const bounds = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    if (clientY < bounds.top + EDGE_PX) edgeDelta = -EDGE_STEP_PX;
    else if (clientY > bounds.bottom - EDGE_PX) edgeDelta = EDGE_STEP_PX;
    else edgeDelta = 0;
    if (edgeDelta) runEdgeScroll(clientY);
    else stopEdgeScroll();
  }

  function cleanup() {
    const wasDragging = from >= 0;
    stopEdgeScroll();
    rows.forEach((row) => {
      row.style.transform = "";
      row.classList.remove("is-reorder-dragging");
    });
    node.classList.remove("is-reordering");
    if (handle && pointerId >= 0) {
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // Already released with the pointer itself.
      }
    }
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKeyDown, true);
    rows = [];
    rects = [];
    from = -1;
    target = -1;
    dragged = null;
    handle = null;
    pointerId = -1;
    scroller = null;
    scrollShift = 0;
    if (wasDragging) opts.ondragstate?.(false);
  }

  function onPointerMove(event: PointerEvent) {
    if (from < 0 || event.pointerId !== pointerId) return;
    event.preventDefault();
    const dy = currentDy(event.clientY);
    resolveTarget(dy);
    paint(dy);
    updateEdgeScroll(event.clientY);
  }

  function onPointerUp(event: PointerEvent) {
    if (from < 0 || event.pointerId !== pointerId) return;
    const moved = target !== from ? { from: rowIndex(rows[from]!), to: rowIndex(rows[target]!) } : null;
    cleanup();
    if (moved && moved.from >= 0 && moved.to >= 0) opts.onmove(moved.from, moved.to);
  }

  function onCancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    cleanup();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cleanup();
  }

  function onPointerDown(event: PointerEvent) {
    if (opts.enabled === false || from >= 0) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const grip = (event.target as Element | null)?.closest(HANDLE_SELECTOR);
    if (!(grip instanceof HTMLElement) || !node.contains(grip)) return;
    const row = grip.closest(ROW_SELECTOR);
    if (!(row instanceof HTMLElement)) return;

    rows = Array.from(node.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) {
      rows = [];
      from = -1;
      return;
    }

    event.preventDefault();
    rects = rows.map((r) => {
      const box = r.getBoundingClientRect();
      return { top: box.top, height: box.height };
    });
    // Row pitch including the flex gap, so shifted rows land where the dragged
    // one was; falls back to the row height for single-gap-free lists.
    const first = rects[0]!;
    const second = rects[1]!;
    step = Math.abs(second.top - first.top) || first.height;
    target = from;
    startY = event.clientY;
    dragged = row;
    handle = grip;
    pointerId = event.pointerId;
    scroller = scrollParent(node);
    scrollFrom = scroller ? scroller.scrollTop : window.scrollY;
    scrollShift = 0;

    node.classList.add("is-reordering");
    row.classList.add("is-reorder-dragging");
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety: the document listeners already follow the pointer.
    }
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKeyDown, true);
    opts.ondragstate?.(true);
  }

  node.addEventListener("pointerdown", onPointerDown);

  return {
    update(next: DragReorderOptions) {
      opts = next;
      if (next.enabled === false && from >= 0) cleanup();
    },
    destroy() {
      cleanup();
      node.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
