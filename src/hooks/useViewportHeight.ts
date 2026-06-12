import { useLayoutEffect } from "react";

const ROOT = document.documentElement;

/**
 * Sincronizza --app-vh con l'altezza visibile reale (visualViewport).
 * La shell usa 100dvh nativo; --app-vh serve solo alle superfici
 * keyboard-aware (es. dialog) che devono restringersi con la tastiera.
 */
export function useViewportHeight() {
  useLayoutEffect(() => {
    const sync = () => {
      const vv = window.visualViewport;
      // Pinch-zoom: l'altezza visuale si riduce ma il layout non deve seguirla.
      if (vv && vv.scale > 1.01) return;
      const h = vv?.height ?? window.innerHeight;
      ROOT.style.setProperty("--app-vh", `${Math.round(h)}px`);
    };

    sync();
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);

    return () => {
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      ROOT.style.removeProperty("--app-vh");
    };
  }, []);
}
