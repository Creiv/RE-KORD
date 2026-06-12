/** Cede il main thread tra fasi pesanti (decode / analisi chart).
 *  In un Worker (niente rIC/rAF) il giro è un setTimeout(0): l'analisi
 *  non deve rallentare, tanto lì non blocca la UI. */
export function yieldUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 48 });
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
