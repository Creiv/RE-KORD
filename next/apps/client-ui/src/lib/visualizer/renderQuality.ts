/** Compact render target + viz loop cadence (ported from legacy renderQuality). */

export type LoopCadence = { minFrameIntervalMs: number };

let coarsePointerMq: MediaQueryList | null = null;
let compactLayoutMq: MediaQueryList | null = null;
let reducedMotionMq: MediaQueryList | null = null;

function coarsePointerMqRef(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (!coarsePointerMq) {
    coarsePointerMq = window.matchMedia("(pointer: coarse)");
  }
  return coarsePointerMq;
}

function compactLayoutMqRef(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (!compactLayoutMq) {
    compactLayoutMq = window.matchMedia("(max-width: 720px)");
  }
  return compactLayoutMq;
}

function reducedMotionMqRef(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (!reducedMotionMq) {
    reducedMotionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  }
  return reducedMotionMq;
}

export function prefersReducedMotion(): boolean {
  return reducedMotionMqRef()?.matches === true;
}

/** Touch o layout compatto: stesso tier su mobile WebView e browser stretto. */
export function isCompactRenderTarget(): boolean {
  if (typeof window !== "undefined" && window.innerWidth < 520) return true;
  return (
    coarsePointerMqRef()?.matches === true ||
    compactLayoutMqRef()?.matches === true
  );
}

/** Visualizer Ascolta: cap FPS condiviso desktop + mobile. */
export function vizLoopCadence(opts: {
  expanded: boolean;
  isPlaying: boolean;
}): LoopCadence {
  if (prefersReducedMotion()) {
    return { minFrameIntervalMs: opts.isPlaying ? 100 : 250 };
  }
  if (opts.expanded) {
    if (opts.isPlaying) {
      return { minFrameIntervalMs: isCompactRenderTarget() ? 28 : 0 };
    }
    return { minFrameIntervalMs: 33 };
  }
  if (opts.isPlaying) {
    return { minFrameIntervalMs: isCompactRenderTarget() ? 48 : 33 };
  }
  return { minFrameIntervalMs: isCompactRenderTarget() ? 80 : 66 };
}

/** Cap DPR canvas (viz panel / expanded). */
export function canvasDprCap(opts?: { lite?: boolean }): number {
  const base = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  if (prefersReducedMotion()) return Math.min(base, 1);
  if (opts?.lite && isCompactRenderTarget()) return Math.min(base, 1.35);
  if (isCompactRenderTarget()) return Math.min(base, 1.5);
  return Math.min(base, opts?.lite ? 1.75 : 2);
}
