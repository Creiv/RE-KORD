/**
 * Verifica runtime se backdrop-filter: blur() è utilizzabile.
 *
 * Nota: non esiste un'API web per leggere i pixel renderizzati del DOM,
 * quindi non è possibile un test visivo diretto (il vecchio tentativo con
 * createImageBitmap(elemento) lanciava sempre TypeError e il probe falliva
 * per chiunque, disattivando il vetro subito dopo l'attivazione). Ci si
 * affida a CSS.supports più la preferenza di sistema sulla trasparenza.
 */
export async function probeGlassBackdrop(): Promise<boolean> {
  if (typeof document === "undefined") return true;
  if (
    !CSS.supports("backdrop-filter", "blur(2px)") &&
    !CSS.supports("-webkit-backdrop-filter", "blur(2px)")
  ) {
    return false;
  }
  if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) {
    return false;
  }
  return true;
}
