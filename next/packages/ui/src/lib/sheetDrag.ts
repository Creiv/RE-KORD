/**
 * Trascinamento verso il basso per chiudere un foglio.
 *
 * Su telefono il dialogo arriva dal bordo inferiore e la × sta in alto a destra,
 * lontana dal pollice: il gesto naturale per farlo sparire è spingerlo giù. Qui
 * c'è la geometria pura (`createSheetDragGesture`, testabile senza DOM) e l'azione
 * Svelte che la attacca al pannello.
 */

/** Sotto questo spostamento è ancora un tocco fermo, non un trascinamento. */
export const SHEET_ACTIVATE_PX = 8;
/** Da qui in giù il foglio si chiude anche se il dito si è fermato. */
export const SHEET_DISMISS_PX = 96;
/** Uno strappo veloce chiude prima di arrivare alla soglia. */
export const SHEET_FLICK_PX_PER_MS = 0.5;
/** Ma non basta sfiorare: un colpetto di pochi pixel resta un tocco. */
export const SHEET_FLICK_MIN_PX = 24;

/** Stessa soglia della cromatura mobile: vedi styles/tokens.css e sheet.css. */
export const SHEET_MEDIA_QUERY = "(max-width: 999.98px)";

export interface SheetDragGesture {
  /** Inizia a seguire il dito. */
  start(y: number, time: number): void;
  /** Restituisce di quanto va spostato il foglio, mai sopra la sua posizione. */
  move(y: number, time: number): number;
  /** Chiude la presa e dice se il foglio deve andarsene. */
  end(y: number, time: number): { dismiss: boolean };
  /** Vero quando lo spostamento ha superato la soglia di attivazione. */
  isDragging(): boolean;
  cancel(): void;
}

export function createSheetDragGesture(): SheetDragGesture {
  let startY = 0;
  let startTime = 0;
  let tracking = false;
  let dragging = false;

  const offsetFor = (y: number) => Math.max(0, y - startY);

  return {
    start(y, time) {
      startY = y;
      startTime = time;
      tracking = true;
      dragging = false;
    },
    move(y, time) {
      if (!tracking) return 0;
      const offset = offsetFor(y);
      if (!dragging && offset > SHEET_ACTIVATE_PX) dragging = true;
      void time;
      return dragging ? offset : 0;
    },
    end(y, time) {
      if (!tracking) return { dismiss: false };
      const offset = offsetFor(y);
      const elapsed = Math.max(1, time - startTime);
      const speed = offset / elapsed;
      tracking = false;
      dragging = false;
      const dismiss =
        offset >= SHEET_DISMISS_PX ||
        (offset >= SHEET_FLICK_MIN_PX && speed >= SHEET_FLICK_PX_PER_MS);
      return { dismiss };
    },
    isDragging() {
      return dragging;
    },
    cancel() {
      tracking = false;
      dragging = false;
    },
  };
}

export interface SheetDragOptions {
  /** Attivo solo quando il dialogo è davvero un foglio (telefono). */
  enabled: boolean;
  /** Da dove si può prendere il foglio: la maniglia e la sua intestazione. */
  gripSelector: string;
  onclose: () => void;
}

/** Quanto dura il ritorno a posto quando il gesto non è bastato. */
const SNAP_BACK_MS = 160;

/**
 * Azione Svelte: si applica al pannello del foglio, che è anche l'elemento che
 * si sposta. La presa però vale solo dentro `gripSelector`, altrimenti scorrere
 * il contenuto o premere un bottone farebbe partire il gesto.
 */
export function sheetDrag(node: HTMLElement, options: SheetDragOptions) {
  let opts = options;
  const gesture = createSheetDragGesture();
  let activePointer: number | null = null;

  const setOffset = (px: number) => {
    node.style.transform = px > 0 ? `translateY(${px}px)` : "";
  };

  const snapBack = () => {
    node.style.transition = `transform ${SNAP_BACK_MS}ms ease`;
    setOffset(0);
    window.setTimeout(() => {
      node.style.transition = "";
    }, SNAP_BACK_MS + 40);
  };

  const stop = () => {
    if (activePointer != null && node.hasPointerCapture(activePointer)) {
      node.releasePointerCapture(activePointer);
    }
    activePointer = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!opts.enabled || activePointer != null || !e.isPrimary) return;
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest(opts.gripSelector)) return;
    // Un comando dentro l'intestazione (la × per prima) resta un comando.
    if (e.target.closest("button, a, input, select, textarea")) return;

    activePointer = e.pointerId;
    node.style.transition = "";
    gesture.start(e.clientY, e.timeStamp);
    node.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return;
    const offset = gesture.move(e.clientY, e.timeStamp);
    if (gesture.isDragging()) {
      e.preventDefault();
      setOffset(offset);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return;
    const { dismiss } = gesture.end(e.clientY, e.timeStamp);
    stop();
    if (dismiss) {
      opts.onclose();
      // Il foglio viene smontato: la posizione va azzerata per il prossimo giro.
      setOffset(0);
      return;
    }
    snapBack();
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return;
    gesture.cancel();
    stop();
    snapBack();
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerCancel);

  return {
    update(next: SheetDragOptions) {
      opts = next;
      if (!next.enabled) {
        gesture.cancel();
        stop();
        node.style.transition = "";
        setOffset(0);
      }
    },
    destroy() {
      stop();
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
    },
  };
}
