/**
 * Cross-tab awareness through the `storage` event.
 *
 * Two tabs of the client share one localStorage: the account binding and the
 * per-account prefs. The browser only fires `storage` in the *other* tabs, so
 * this never echoes back to the writer. Prefs are written on every small edit
 * (play counts, moods), hence the debounce.
 */

const ACCOUNT_KEY = "rekord.next.sessionAccountId";
const PREFS_PREFIX = "rekord.next.userPrefs.";

export type TabSyncHandlers = {
  /** Another tab bound the client to a different account. */
  onAccount?: (accountId: string) => void;
  /** Another tab rewrote the prefs of this account. */
  onPrefs?: (accountId: string) => void;
};

const PREFS_DEBOUNCE_MS = 400;

export function watchOtherTabs(handlers: TabSyncHandlers): () => void {
  if (typeof window === "undefined") return () => {};
  let prefsTimer: ReturnType<typeof setTimeout> | null = null;

  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.newValue == null) return;
    if (event.key === ACCOUNT_KEY) {
      const id = event.newValue.trim();
      if (id) handlers.onAccount?.(id);
      return;
    }
    if (event.key.startsWith(PREFS_PREFIX)) {
      const accountId = event.key.slice(PREFS_PREFIX.length);
      if (!accountId) return;
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(() => {
        prefsTimer = null;
        handlers.onPrefs?.(accountId);
      }, PREFS_DEBOUNCE_MS);
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    if (prefsTimer) clearTimeout(prefsTimer);
    window.removeEventListener("storage", onStorage);
  };
}
