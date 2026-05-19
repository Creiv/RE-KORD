import { useLayoutEffect } from "react";
import { MOBILE_LAYOUT_MQ } from "../lib/breakpoints";

const ROOT = document.documentElement;

/**
 * Sincronizza --bar-h e data-player-dock con l'altezza reale del dock (ResizeObserver).
 */
export function usePlayerDockCssVars(queueLength: number) {
  useLayoutEffect(() => {
    if (queueLength === 0) {
      ROOT.dataset.playerDock = "0";
      ROOT.style.removeProperty("--bar-h");
      return;
    }

    ROOT.dataset.playerDock = "1";

    const applyHeight = (px: number) => {
      const h = Math.max(0, Math.ceil(px));
      ROOT.style.setProperty("--bar-h", `${h}px`);
    };

    const dock = document.querySelector<HTMLElement>(".player-dock2");
    if (!dock) {
      applyHeight(parseFallbackBarHeight());
      return;
    }

    applyHeight(dock.getBoundingClientRect().height);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    ro.observe(dock);

    const onMq = () => applyHeight(dock.getBoundingClientRect().height);
    const mql = window.matchMedia(MOBILE_LAYOUT_MQ);
    mql.addEventListener("change", onMq);

    return () => {
      ro.disconnect();
      mql.removeEventListener("change", onMq);
    };
  }, [queueLength]);
}

function parseFallbackBarHeight(): number {
  const raw = getComputedStyle(ROOT).getPropertyValue("--bar-h").trim();
  if (raw.endsWith("px")) return Number.parseFloat(raw) || 120;
  if (raw.endsWith("rem")) {
    const rem = Number.parseFloat(raw) || 7;
    const base = Number.parseFloat(getComputedStyle(ROOT).fontSize) || 16;
    return rem * base;
  }
  return 120;
}
