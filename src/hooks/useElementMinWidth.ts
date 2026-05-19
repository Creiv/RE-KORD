import { type RefObject, useLayoutEffect, useState } from "react";

/** `true` quando l’elemento osservato ha larghezza ≥ `minWidthPx`. */
export function useElementMinWidth(
  ref: RefObject<HTMLElement | null>,
  minWidthPx: number
): boolean {
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const sync = () => {
      setWide(el.getBoundingClientRect().width >= minWidthPx);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minWidthPx]);

  return wide;
}
