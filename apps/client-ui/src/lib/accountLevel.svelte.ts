/**
 * The bound account's achievements snapshot (XP, level, badges), computed in
 * one place so every surface shows the same level: the rail ring, Settings ›
 * Account and the Achievements view. Legacy did the same (`SideBar.tsx`).
 *
 * Reactive and cheap: re-derived only when play counts, exclusions, the
 * catalog, favourites, playlists or Plectr records change — never on player
 * ticks.
 */
import {
  STREAK_SETTING_KEY,
  buildAchievementsSnapshot,
  mergeStreakStates,
  normalizeStreakState,
  setStreakSync,
  type AchievementsSnapshot,
} from "./achievements";
import { primaryGenre } from "./genres";
import { selectPlectrCareer } from "./plectr/records";
import { plectrRecords } from "./plectr/persist.svelte";
import { prefsRevision } from "./prefsRevision.svelte";
import { session } from "./session.svelte";
import { loadUserPrefs } from "./userPrefs";

// The listening streak lives in the synced account settings (issue #100):
// read merged with this device's copy, written through the session, combined
// with the hub's copy on every pull and conflict rebase.
setStreakSync({
  get: () => session.syncedSetting(STREAK_SETTING_KEY),
  set: (state) => session.setSyncedSetting(STREAK_SETTING_KEY, state),
});
session.registerSyncedMerge(STREAK_SETTING_KEY, (local, remote) =>
  mergeStreakStates(normalizeStreakState(local), normalizeStreakState(remote)),
);

class AccountAchievements {
  /** Null until the account state and the catalog are there. */
  readonly snapshot: AchievementsSnapshot | null = $derived.by(() => {
    const counts = prefsRevision.playCountsMap;
    void prefsRevision.exclusions;
    const tracks = session.catalogTracks;
    if (!session.userStateHydrated || (!tracks.length && !session.catalogLoaded)) return null;
    const prefs = loadUserPrefs();
    const playlists = session.playlists;
    let plectrCareer: ReturnType<typeof selectPlectrCareer> | null = null;
    try {
      plectrCareer = selectPlectrCareer(plectrRecords.store);
    } catch {
      /* Plectr records unreadable: they just do not count */
    }
    return buildAchievementsSnapshot({
      playCounts: counts as Record<string, number>,
      tracks,
      favoritesCount: session.favorites.length,
      playlistsCount: playlists.length,
      playlistTrackCount: playlists.reduce((s, p) => s + (p.track_count ?? 0), 0),
      libraryTrackCount: session.stats?.track_count ?? tracks.length,
      shuffleBlocks: prefs.excludedRelPaths.length + prefs.excludedAlbumIds.length,
      genreForTrack: (tr) => primaryGenre(tr),
      plectrCareer,
    });
  });

  /** Level number (1+), or null while loading. */
  get level(): number | null {
    return this.snapshot?.level.level ?? null;
  }

  /** Progress through the current level, 0–100. */
  get pct(): number {
    return this.snapshot?.progress.pct ?? 0;
  }
}

export const accountAchievements = new AccountAchievements();
