/**
 * Swipe orizzontale sulla barra del player: destra = brano precedente,
 * sinistra = successivo, tocco = apre Studio → Ascolta.
 *
 * La matematica del gesto sta in `createSwipeGesture` senza toccare il DOM, così
 * le soglie si possono verificare con i test node; l'azione `playerSwipe` la
 * collega agli eventi pointer. Soglie come nel dock 5.x (usePlayerBarSwipe).
 */

/** Spostamento oltre il quale il gesto diventa uno swipe e non uno scroll. */
export const SWIPE_ACTIVATE_PX = 12;
/** Spostamento che fa scattare il cambio brano. */
export const SWIPE_THRESHOLD_PX = 48;
/** Oltre questo movimento verticale il gesto è uno scroll, non uno swipe. */
export const SWIPE_MAX_VERTICAL_PX = 40;
/** Entro questo movimento il gesto conta come tocco. */
export const TAP_MAX_MOVE_PX = 10;

export type SwipeMove = "idle" | "capture" | "cancel" | "prev" | "next";
export type SwipeEnd = "tap" | "none";

export type SwipeGesture = {
  begin(x: number, y: number): void;
  /** `capture` chiede al chiamante di prendere il pointer capture. */
  move(x: number, y: number): SwipeMove;
  end(x: number, y: number): SwipeEnd;
  abort(): void;
  /** Vero se il gesto ha cambiato brano: serve a sopprimere il click che segue. */
  get fired(): boolean;
  get capturing(): boolean;
};

export function createSwipeGesture(): SwipeGesture {
  let start: { x: number; y: number } | null = null;
  let capturing = false;
  let fired = false;

  const reset = () => {
    start = null;
    capturing = false;
  };

  return {
    begin(x, y) {
      start = { x, y };
      capturing = false;
      fired = false;
    },
    move(x, y) {
      if (!start || fired) return "idle";
      const dx = x - start.x;
      const dy = y - start.y;
      if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX) {
        reset();
        return "cancel";
      }
      if (!capturing) {
        if (Math.abs(dx) < SWIPE_ACTIVATE_PX || Math.abs(dx) <= Math.abs(dy)) {
          return "idle";
        }
        capturing = true;
        return "capture";
      }
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return "idle";
      fired = true;
      reset();
      return dx > 0 ? "prev" : "next";
    },
    end(x, y) {
      if (!start) {
        reset();
        return "none";
      }
      const dx = Math.abs(x - start.x);
      const dy = Math.abs(y - start.y);
      const tap = !fired && dx <= TAP_MAX_MOVE_PX && dy <= TAP_MAX_MOVE_PX;
      reset();
      return tap ? "tap" : "none";
    },
    abort() {
      reset();
      fired = false;
    },
    get fired() {
      return fired;
    },
    get capturing() {
      return capturing;
    },
  };
}

export type PlayerSwipeOptions = {
  enabled: boolean;
  onprev: () => void;
  onnext: () => void;
  /** Tocco sulla barra: tipicamente apre Studio → Ascolta. */
  ontap?: () => void;
  /**
   * Elementi che gestiscono il proprio gesto: trasporto, barra di posizione,
   * campi. Lì il gesto non parte nemmeno.
   */
  ignoreSelector?: string;
  /**
   * Elementi che restano swipeabili ma non rispondono al tocco, perché hanno
   * già una loro destinazione: artista e album nella riga del brano.
   */
  tapIgnoreSelector?: string;
};

const DEFAULT_IGNORE = "input, [data-swipe-ignore]";

/** Azione Svelte: `use:playerSwipe={{ enabled, onprev, onnext, ontap }}`. */
export function playerSwipe(node: HTMLElement, options: PlayerSwipeOptions) {
  let opts = options;
  const gesture = createSwipeGesture();
  let pointerId: number | null = null;
  let suppressClick = false;

  const ignored = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return true;
    const selector = opts.ignoreSelector
      ? `${DEFAULT_IGNORE}, ${opts.ignoreSelector}`
      : DEFAULT_IGNORE;
    return target.closest(selector) !== null;
  };

  const capture = (id: number) => {
    try {
      node.setPointerCapture(id);
    } catch {
      /* il pointer può essere già uscito dalla pagina */
    }
  };

  const release = () => {
    if (pointerId === null) return;
    try {
      node.releasePointerCapture(pointerId);
    } catch {
      /* il pointer può essere già stato rilasciato dal browser */
    }
    pointerId = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!opts.enabled || ignored(e.target)) return;
    pointerId = e.pointerId;
    suppressClick = false;
    gesture.begin(e.clientX, e.clientY);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    const move = gesture.move(e.clientX, e.clientY);
    if (move === "capture") {
      capture(e.pointerId);
      return;
    }
    if (move === "prev" || move === "next") {
      suppressClick = true;
      release();
      if (move === "prev") opts.onprev();
      else opts.onnext();
    }
  };

  const tapIgnored = (target: EventTarget | null): boolean => {
    if (ignored(target)) return true;
    if (!opts.tapIgnoreSelector) return false;
    return (
      target instanceof Element &&
      target.closest(opts.tapIgnoreSelector) !== null
    );
  };

  const onPointerUp = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    const end = gesture.end(e.clientX, e.clientY);
    release();
    if (end === "tap" && !tapIgnored(e.target)) opts.ontap?.();
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    gesture.abort();
    release();
  };

  /** Lo swipe finisce sopra un pulsante: il click che segue non deve partire. */
  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerCancel);
  node.addEventListener("click", onClickCapture, true);

  return {
    update(next: PlayerSwipeOptions) {
      opts = next;
      if (!next.enabled) {
        gesture.abort();
        release();
      }
    },
    destroy() {
      release();
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
      node.removeEventListener("click", onClickCapture, true);
    },
  };
}
