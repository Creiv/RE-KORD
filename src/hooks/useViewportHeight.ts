import { useLayoutEffect } from "react";

const ROOT = document.documentElement;

/** Sincronizza --app-vh con l'altezza visibile reale (visualViewport). */
export function useViewportHeight() {
  useLayoutEffect(() => {
    const sync = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
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
