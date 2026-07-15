import { useEffect, useState } from "react";

const listeners = new Set<(foreground: boolean) => void>();
let foregroundSnapshot =
  typeof document === "undefined" || document.visibilityState === "visible";

function readForeground(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function emitForeground(next: boolean) {
  if (foregroundSnapshot === next) return;
  foregroundSnapshot = next;
  for (const fn of listeners) fn(next);
}

/** Sottoscrizione foreground (visibility + Capacitor appState). */
export function subscribeAppForeground(
  onChange: (foreground: boolean) => void,
): () => void {
  listeners.add(onChange);
  onChange(foregroundSnapshot);
  return () => listeners.delete(onChange);
}

/** Stato foreground per viz/poll (Capacitor + visibility). */
export function isAppInForeground(): boolean {
  return foregroundSnapshot;
}

/** Hook React per sapere se l'app è in foreground. */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(foregroundSnapshot);
  useEffect(() => subscribeAppForeground(setForeground), []);
  return foreground;
}

/** Registra listener globali (idempotente). */
export function installAppForegroundListeners(): () => void {
  if (typeof document === "undefined") return () => {};

  const onVisibility = () => emitForeground(readForeground());
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onVisibility);
  window.addEventListener("focus", onVisibility);
  const onBlur = () => emitForeground(readForeground());
  window.addEventListener("blur", onBlur);

  let removeCapacitor: (() => void) | undefined;
  void import("@capacitor/core")
    .then(({ Capacitor }) => {
      if (!Capacitor.isNativePlatform()) return;
      return import("@capacitor/app").then(({ App }) =>
        App.addListener("appStateChange", ({ isActive }) => {
          emitForeground(isActive);
        }),
      );
    })
    .then((handle) => {
      if (handle) removeCapacitor = () => handle.remove();
    })
    .catch(() => {
      /* test / browser */
    });

  emitForeground(readForeground());

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onVisibility);
    window.removeEventListener("focus", onVisibility);
    window.removeEventListener("blur", onBlur);
    removeCapacitor?.();
  };
}

let uninstallGlobal: (() => void) | null = null;

/** Una sola installazione per processo browser. */
export function ensureAppForegroundListeners(): void {
  if (typeof document === "undefined") return;
  if (uninstallGlobal) return;
  uninstallGlobal = installAppForegroundListeners();
}
