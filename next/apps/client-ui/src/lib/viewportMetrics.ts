/**
 * Tiene `--rk-app-vh` allineata all'altezza davvero visibile della finestra.
 *
 * Con `interactive-widget=overlays-content` la tastiera virtuale copre la pagina
 * senza rimpicciolire il viewport: `dvh` continua a valere tutto lo schermo e un
 * dialogo alto 90dvh finisce sotto i tasti. Il visual viewport invece si accorcia,
 * quindi lo leggiamo da qui e lo passiamo al CSS.
 */

/** Sopra questo ingrandimento il visual viewport è la lente, non la finestra. */
const PINCH_ZOOM_LIMIT = 1.01;

export function trackViewportMetrics(): () => void {
  if (typeof window === "undefined") return () => {};

  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = () => {
    // Durante un pinch-zoom l'altezza è quella della porzione ingrandita: se la
    // usassimo, i dialoghi si accorcerebbero solo perché l'utente ha zoomato.
    if (vv && vv.scale > PINCH_ZOOM_LIMIT) return;
    const h = Math.round(vv?.height ?? window.innerHeight);
    if (h > 0) root.style.setProperty("--rk-app-vh", `${h}px`);
  };

  apply();
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);

  return () => {
    vv?.removeEventListener("resize", apply);
    vv?.removeEventListener("scroll", apply);
    window.removeEventListener("resize", apply);
    window.removeEventListener("orientationchange", apply);
    root.style.removeProperty("--rk-app-vh");
  };
}
