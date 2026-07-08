/**
 * Migrazione one-shot naming legacy KORD/WPP → REKORD (client storage).
 */
const LEGACY_STORAGE_MAP = [
  ["kord-session-account-id", "rekord-session-account-id"],
  ["kord-active-account-id", "rekord-active-account-id"],
  ["wpp-playlists", "rekord-playlists"],
  ["wpp-favorites", "rekord-favorites"],
  ["wpp-recent", "rekord-recent"],
  ["wpp-viz", "rekord-viz"],
  ["kord-playlists", "rekord-playlists"],
  ["kord-favorites", "rekord-favorites"],
  ["kord-recent", "rekord-recent"],
  ["kord-viz", "rekord-viz"],
];

export function migrateLegacyStorageKeys(storage = localStorage) {
  let migrated = 0;
  for (const [from, to] of LEGACY_STORAGE_MAP) {
    try {
      const val = storage.getItem(from);
      if (val == null) continue;
      if (storage.getItem(to) == null) storage.setItem(to, val);
      storage.removeItem(from);
      migrated += 1;
    } catch {
      /* ignore quota / private mode */
    }
  }
  return migrated;
}

export function readSessionAccountId(storage = localStorage) {
  migrateLegacyStorageKeys(storage);
  return (
    storage.getItem("rekord-session-account-id") ||
    storage.getItem("rekord-active-account-id") ||
    ""
  ).trim();
}
