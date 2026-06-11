import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Sotto questa soglia la lista è renderizzata per intero (nessun overhead). */
const DEFAULT_VIRTUALIZE_FROM = 80;
const DEFAULT_ESTIMATED_ROW_PX = 72;
const DEFAULT_LIST_GAP_PX = 12;

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
 * Lista brani virtualizzata: monta solo le righe visibili (più overscan).
 * Sotto `virtualizeFrom` elementi si comporta come una normale `.list-stack`.
 *
 * Nota: in modalità virtualizzata le righe vengono smontate/rimontate durante
 * lo scroll, quindi il chiamante deve disattivare lo scroll automatico della
 * riga attiva (`autoFocusActive={false}`) e usare `followIndex` se vuole che
 * la lista segua il brano corrente.
 */
export function VirtualTrackList<T>({
  items,
  getKey,
  renderRow,
  followIndex,
  virtualizeFrom = DEFAULT_VIRTUALIZE_FROM,
  estimateRowPx = DEFAULT_ESTIMATED_ROW_PX,
  className = "list-stack",
}: {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  /** `virtualized` indica se la riga vive in una lista virtualizzata. */
  renderRow: (item: T, index: number, virtualized: boolean) => ReactNode;
  /** Indice da tenere visibile (es. brano corrente in coda). */
  followIndex?: number;
  virtualizeFrom?: number;
  estimateRowPx?: number;
  className?: string;
}) {
  const virtualized = items.length >= virtualizeFrom;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [gapPx, setGapPx] = useState(DEFAULT_LIST_GAP_PX);
  const [scrollMarginPx, setScrollMarginPx] = useState(0);

  useLayoutEffect(() => {
    if (!virtualized) return;
    const container = containerRef.current;
    if (!container) return;
    const scroller = findScrollParent(container);
    setScrollEl(scroller);
    const gap = Number.parseFloat(window.getComputedStyle(container).rowGap);
    if (Number.isFinite(gap)) setGapPx(gap);
    if (scroller) {
      const scrollerTop = scroller.getBoundingClientRect().top;
      const containerTop = container.getBoundingClientRect().top;
      setScrollMarginPx(containerTop - scrollerTop + scroller.scrollTop);
    }
  }, [virtualized]);

  const virtualizer = useVirtualizer({
    count: virtualized ? items.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateRowPx,
    overscan: 8,
    gap: gapPx,
    scrollMargin: scrollMarginPx,
  });

  useEffect(() => {
    if (!virtualized || followIndex == null || followIndex < 0) return;
    if (!scrollEl) return;
    virtualizer.scrollToIndex(followIndex, { align: "center" });
    // Va rieseguito solo quando cambia l'indice da seguire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followIndex, virtualized, scrollEl]);

  if (!virtualized) {
    return (
      <div className={className}>
        {items.map((item, index) => renderRow(item, index, false))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`${className} virtual-track-list`}
      style={{
        position: "relative",
        display: "block",
        height: virtualizer.getTotalSize(),
      }}
    >
      {virtualizer.getVirtualItems().map((vItem) => {
        const item = items[vItem.index];
        if (item === undefined) return null;
        return (
          <div
            key={getKey(item, vItem.index)}
            ref={virtualizer.measureElement}
            data-index={vItem.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vItem.start - scrollMarginPx}px)`,
            }}
          >
            {renderRow(item, vItem.index, true)}
          </div>
        );
      })}
    </div>
  );
}
