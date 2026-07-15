import { MOBILE_LAYOUT_MQ } from "./breakpoints";

/** Intervallo minimo tra due frame canvas (ms). 0 = ogni rAF (~60 fps). */
export type LoopCadence = {
  minFrameIntervalMs: number;
};

/** Cap ~30 fps canvas Nebula su mobile / coarse pointer. */
export const NEBULA_MOBILE_FRAME_MS = 33;

let coarsePointerMq: MediaQueryList | null = null;
let compactLayoutMq: MediaQueryList | null = null;
let reducedMotionMq: MediaQueryList | null = null;

/** Solo test: invalida cache matchMedia tra casi vitest. */
export function resetRenderQualityMqCacheForTests(): void {
  coarsePointerMq = null;
  compactLayoutMq = null;
  reducedMotionMq = null;
}

function coarsePointerMqRef(): MediaQueryList | null {
  if (typeof matchMedia === "undefined") return null;
  if (!coarsePointerMq) coarsePointerMq = matchMedia("(pointer: coarse)");
  return coarsePointerMq;
}

function compactLayoutMqRef(): MediaQueryList | null {
  if (typeof matchMedia === "undefined") return null;
  if (!compactLayoutMq) compactLayoutMq = matchMedia(MOBILE_LAYOUT_MQ);
  return compactLayoutMq;
}

function reducedMotionMqRef(): MediaQueryList | null {
  if (typeof matchMedia === "undefined") return null;
  if (!reducedMotionMq) {
    reducedMotionMq = matchMedia("(prefers-reduced-motion: reduce)");
  }
  return reducedMotionMq;
}

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
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

/** Poll libreria: frequente in foreground, raro in background. */
export function libraryPollIntervalMs(
  hidden = isDocumentHidden(),
  isPlaying = false,
): number {
  if (hidden) return 30_000;
  if (isCompactRenderTarget()) return isPlaying ? 15_000 : 8_000;
  return 4_000;
}

/** Sync Media Session nativa/APK: meno frequente in background. */
export function mediaSessionSyncIntervalMs(
  isPlaying: boolean,
  hidden = isDocumentHidden(),
): number {
  if (hidden) return isPlaying ? 10_000 : 30_000;
  if (isPlaying) return isCompactRenderTarget() ? 2_000 : 1_000;
  return 2_500;
}

/** DiscoWall Ascolta: cap FPS panel vs expanded, attivo vs calmo. */
export function discowallLoopCadence(opts: {
  expanded: boolean;
  active: boolean;
}): LoopCadence {
  if (prefersReducedMotion()) {
    return { minFrameIntervalMs: 120 };
  }
  if (isDocumentHidden()) {
    return { minFrameIntervalMs: 250 };
  }
  if (opts.expanded) {
    if (opts.active) {
      return { minFrameIntervalMs: isCompactRenderTarget() ? 22 : 16 };
    }
    return { minFrameIntervalMs: isCompactRenderTarget() ? 28 : 22 };
  }
  return { minFrameIntervalMs: isCompactRenderTarget() ? 40 : 33 };
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

/** Sonic Nebula: throttle frame quando idle o in anteprima. */
export function nebulaLoopCadence(opts: {
  active: boolean;
  preview?: boolean;
}): LoopCadence {
  if (prefersReducedMotion()) {
    return { minFrameIntervalMs: opts.active ? 80 : 250 };
  }
  if (isDocumentHidden()) {
    return { minFrameIntervalMs: 250 };
  }
  if (opts.active) {
    return {
      minFrameIntervalMs: isCompactRenderTarget() ? NEBULA_MOBILE_FRAME_MS : 0,
    };
  }
  if (opts.preview) {
    if (!opts.active) {
      return {
        minFrameIntervalMs: isCompactRenderTarget() ? 250 : 100,
      };
    }
    return {
      minFrameIntervalMs: isCompactRenderTarget()
        ? Math.max(NEBULA_MOBILE_FRAME_MS, 80)
        : 50,
    };
  }
  return {
    minFrameIntervalMs: isCompactRenderTarget()
      ? Math.max(NEBULA_MOBILE_FRAME_MS, 40)
      : 40,
  };
}

/** Sfondo viz Plectr: offscreen ridotto + fps capped. */
export function plectrBackdropCadence(): { scale: number; intervalMs: number } {
  if (prefersReducedMotion()) {
    return { scale: 0.35, intervalMs: 120 };
  }
  if (isCompactRenderTarget()) {
    return { scale: 0.4, intervalMs: 48 };
  }
  return { scale: 0.5, intervalMs: 32 };
}

/** Cap DPR canvas (Plectr, Nebula, viz expanded). */
export function canvasDprCap(opts?: { lite?: boolean }): number {
  const base = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  if (prefersReducedMotion()) return Math.min(base, 1);
  if (opts?.lite && isCompactRenderTarget()) return Math.min(base, 1.35);
  if (isCompactRenderTarget()) return Math.min(base, 1.5);
  return Math.min(base, opts?.lite ? 1.75 : 2);
}
