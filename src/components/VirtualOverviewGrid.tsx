import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** ~19rem — allineato a `.library-overview-cols` */
const MIN_COL_PX = 304;
const ROW_HEIGHT_PX = 92;
const DEFAULT_VIRTUALIZE_FROM = 28;

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Griglia responsive virtualizzata per tile artisti/generi.
 * Sotto `virtualizeFrom` elementi renderizza tutto senza overhead.
 */
export function VirtualOverviewGrid<T>({
  items,
  getKey,
  renderItem,
  className = "library-overview-cols",
  virtualizeFrom = DEFAULT_VIRTUALIZE_FROM,
  onNearEnd,
  nearEndRowThreshold = 2,
  footer,
}: {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  virtualizeFrom?: number;
  /** Chiamato quando l'utente avvicina la fine della lista (infinite scroll). */
  onNearEnd?: () => void;
  nearEndRowThreshold?: number;
  footer?: ReactNode;
}) {
  const virtualized = items.length >= virtualizeFrom;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [columnCount, setColumnCount] = useState(1);
  const [gapPx, setGapPx] = useState(16);
  const nearEndRef = useRef(onNearEnd);
  nearEndRef.current = onNearEnd;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const width = container.clientWidth;
      const style = window.getComputedStyle(container);
      const gap = Number.parseFloat(style.columnGap || style.gap);
      const gapVal = Number.isFinite(gap) ? gap : 16;
      setGapPx(gapVal);
      const cols = Math.max(1, Math.floor((width + gapVal) / (MIN_COL_PX + gapVal)));
      setColumnCount(cols);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!virtualized) return;
    const container = containerRef.current;
    if (!container) return;
    setScrollEl(findScrollParent(container));
  }, [virtualized]);

  const rowCount = Math.ceil(items.length / columnCount);

  const rowVirtualizer = useVirtualizer({
    count: virtualized ? rowCount : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 3,
    gap: gapPx,
  });

  useEffect(() => {
    if (!virtualized || !onNearEnd) return;
    const rows = rowVirtualizer.getVirtualItems();
    if (!rows.length) return;
    const last = rows[rows.length - 1]!.index;
    if (last >= rowCount - 1 - nearEndRowThreshold) {
      nearEndRef.current?.();
    }
  }, [
    nearEndRowThreshold,
    onNearEnd,
    rowCount,
    rowVirtualizer,
    virtualized,
    items.length,
  ]);

  if (!virtualized) {
    return (
      <div ref={containerRef} className={className}>
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderItem(item, index)}</div>
        ))}
        {footer}
      </div>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        height: rowVirtualizer.getTotalSize(),
        width: "100%",
        position: "relative",
      }}
    >
      {virtualRows.map((virtualRow) => {
        const rowStart = virtualRow.index * columnCount;
        const rowItems = items.slice(rowStart, rowStart + columnCount);
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
              display: "grid",
              gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              gap: gapPx,
            }}
          >
            {rowItems.map((item, colIndex) => {
              const index = rowStart + colIndex;
              return (
                <div key={getKey(item, index)}>{renderItem(item, index)}</div>
              );
            })}
          </div>
        );
      })}
      {footer ? (
        <div
          style={{
            position: "absolute",
            top: rowVirtualizer.getTotalSize(),
            left: 0,
            width: "100%",
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
