import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const MOBILE_MAX_ROWS = 3;
const MOBILE_MIN_COLS = 3;
const MOBILE_MAX_COLS = 5;

const DESKTOP_MIN_COLS = 4;
const DESKTOP_MAX_COLS = 14;

/** Tile compatte stile YouTube Music (~min 5.5rem). */
const MIN_TILE_REM = 5.5;
const COLUMN_GAP_REM = 0.65;

function readColumnGapPx(grid: HTMLElement, rootFontPx: number): number {
  const g = getComputedStyle(grid).columnGap;
  const n = parseFloat(g);
  const font = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : 16;
  if (Number.isFinite(n) && n > 0) return n;
  return COLUMN_GAP_REM * font;
}

function estimateSmartRadioColumns(
  grid: HTMLElement,
  minTileRem: number,
): number {
  const width = grid.clientWidth;
  if (width <= 8) return 1;
  const rootFontPx = parseFloat(
    getComputedStyle(document.documentElement).fontSize || "16",
  );
  const minTrackPx = Math.min(
    minTileRem * (Number.isFinite(rootFontPx) ? rootFontPx : 16),
    width,
  );
  const gap = readColumnGapPx(grid, rootFontPx);
  return Math.max(1, Math.floor((width + gap) / (minTrackPx + gap)));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Slot totali (brani + tasto Random). */
export function smartRadioTotalSlots(columns: number, rows: number): number {
  return Math.max(1, columns * rows);
}

export function useDashboardSmartRadioGrid(isMobile: boolean) {
  const ref: RefObject<HTMLDivElement | null> = useRef(null);
  const [columns, setColumns] = useState(isMobile ? 3 : 6);
  const [rows, setRows] = useState(1);
  const [slotCount, setSlotCount] = useState(7);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      const rawCols = estimateSmartRadioColumns(el, MIN_TILE_REM);
      if (isMobile) {
        const cols = clamp(rawCols, MOBILE_MIN_COLS, MOBILE_MAX_COLS);
        const rowCount = MOBILE_MAX_ROWS;
        setColumns(cols);
        setRows(rowCount);
        setSlotCount(smartRadioTotalSlots(cols, rowCount));
        return;
      }
      const cols = clamp(rawCols, DESKTOP_MIN_COLS, DESKTOP_MAX_COLS);
      setColumns(cols);
      setRows(1);
      setSlotCount(smartRadioTotalSlots(cols, 1));
    };

    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    const id = requestAnimationFrame(compute);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [isMobile]);

  return { ref, columns, rows, slotCount };
}
