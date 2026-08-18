/**
 * Canonical viewport breakpoints for the client.
 *
 * The same six numbers are documented in `src/styles/responsive.css`, which is
 * where CSS authors read them; this module is the source of truth for the code.
 *
 * Convention, in CSS and here: "up" is `min-width: Npx`, "down" is
 * `max-width: (N - 0.02)px`. A viewport is therefore never on both sides of a
 * breakpoint, and no 1px hole opens up on fractional widths (zoom, hidpi).
 */
export const BREAKPOINTS = {
  /** Narrow phones: metric cards drop to one per row. */
  xs: 400,
  /** Phone: toolbars stop sitting next to their title, action rows stack. */
  sm: 560,
  /** Roomy phone: two-up cards, wider mood and stat grids. */
  md: 640,
  /** Tablet portrait: forms, heroes and detail panels split in two columns. */
  lg: 720,
  /** Tablet landscape: Studio and Listen put their panes side by side. */
  xl: 900,
  /** Desktop chrome: icon rail and full player dock instead of the mobile nav. */
  xxl: 1000,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/**
 * Element widths, not viewport widths: these are compared against a measured
 * `ResizeObserver` box, so they are deliberately not part of the ramp above.
 */
export const CONTAINER_WIDTHS = {
  /** Track row: inline action buttons instead of the overflow menu. */
  trackRowInlineActions: 651,
} as const;

/** Kept off the breakpoint value so `up` and `down` can never both match. */
const DOWN_EPSILON = 0.02;

export function mediaUp(bp: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[bp]}px)`;
}

export function mediaDown(bp: Breakpoint): string {
  return `(max-width: ${BREAKPOINTS[bp] - DOWN_EPSILON}px)`;
}

function mq(query: string): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(query);
}

export function matchesDown(bp: Breakpoint): boolean {
  return mq(mediaDown(bp))?.matches ?? false;
}

/**
 * Calls `on` right away with the current state, then on every change.
 * Returns the unsubscribe.
 */
export function watchDown(
  bp: Breakpoint,
  on: (matches: boolean) => void,
): () => void {
  const list = mq(mediaDown(bp));
  if (!list) {
    on(false);
    return () => {};
  }
  const handler = () => on(list.matches);
  handler();
  list.addEventListener("change", handler);
  return () => list.removeEventListener("change", handler);
}
