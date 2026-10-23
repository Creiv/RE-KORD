/**
 * Per-account switches for the optional experiences (GitHub issue #100):
 * Sonic Nebula, the Studio › Listen visualizer and Plectr. On by default;
 * off, their entries, cards and canvases are not shown and their code is not
 * loaded. Stored in the user prefs, synced with the hub like the theme.
 *
 * Reactive: reads register `prefsRevision.any`, so a `$derived` that calls
 * `features.plectr` updates when the preference changes.
 */
import { prefsRevision } from "./prefsRevision.svelte";
import { loadUserPrefs } from "./userPrefs";

class Features {
  get nebula(): boolean {
    void prefsRevision.any;
    return loadUserPrefs().featureNebula;
  }

  get visualizer(): boolean {
    void prefsRevision.any;
    return loadUserPrefs().featureVisualizer;
  }

  get plectr(): boolean {
    void prefsRevision.any;
    return loadUserPrefs().featurePlectr;
  }
}

export const features = new Features();
