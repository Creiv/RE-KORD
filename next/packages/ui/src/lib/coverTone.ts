/** Theme-aligned cover placeholder tone (parity with 5.x --album-fb-*). */
export type CoverTone = {
  from: string;
  to: string;
  ink: string;
};

/** Deterministic hash kept for callers that need a stable seed index. */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Missing-cover colors follow theme tokens, not a neon hash palette. */
export function coverTone(_seed: string): CoverTone {
  return {
    from: "var(--rk-album-fb-1)",
    to: "var(--rk-album-fb-2)",
    ink: "var(--rk-ink)",
  };
}
