/**
 * Segnale cross-componente per aprire Sonic Nebula già espansa (fullscreen).
 * Stesso pattern di emitStudioPane: evento per la vista già montata, più una
 * finestra temporale per il mount successivo alla navigazione. La finestra
 * (invece di un flag consumato una tantum) copre anche l'eventuale remount
 * della vista subito dopo (es. refresh dell'indice libreria all'avvio).
 */

const NEBULA_FULLSCREEN_EVENT = "rekord-nebula-fullscreen";
const PENDING_WINDOW_MS = 2500;

let pendingUntil = 0;

export function requestNebulaFullscreen() {
  pendingUntil = Date.now() + PENDING_WINDOW_MS;
  window.dispatchEvent(new Event(NEBULA_FULLSCREEN_EVENT));
}

export function consumeNebulaFullscreenRequest(): boolean {
  return Date.now() < pendingUntil;
}

export function onNebulaFullscreenRequest(cb: () => void): () => void {
  const handler = () => {
    if (consumeNebulaFullscreenRequest()) cb();
  };
  window.addEventListener(NEBULA_FULLSCREEN_EVENT, handler);
  return () => window.removeEventListener(NEBULA_FULLSCREEN_EVENT, handler);
}
