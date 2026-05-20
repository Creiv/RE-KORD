/** Modalità riconciliazione indice libreria (AppShell). */
export type LibraryReconcileMode = "debounced" | "now" | "manual";

export type LibraryReconcileOptions = {
  mode?: LibraryReconcileMode;
  /** Solo con `mode: "manual"` (pulsante sync). */
  syncUser?: boolean;
};

/**
 * Dopo metadati/copertina con delta dal server → `onLibraryDelta` (+ debounced opzionale).
 * Dopo download / scan massivi → `mode: "now"`.
 * Pulsante sync sidebar → `mode: "manual"`, `syncUser: true`.
 */
