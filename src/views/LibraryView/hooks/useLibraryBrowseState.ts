import { startTransition, useCallback, useEffect, useState } from "react";
import {
  useUserSettingsSlice,
} from "../../../context/UserStateContext";
import type { TrackMoodId } from "../../../lib/trackMoods";

export type LibrarySearchFilterMode = "all" | "artists" | "albums" | "tracks";

interface UseLibraryBrowseStateOptions {
  libraryHomeTick: number;
  showSearchBar: boolean;
  onSearchBarClose: () => void;
}

export function useLibraryBrowseState({
  libraryHomeTick,
  showSearchBar,
  onSearchBarClose,
}: UseLibraryBrowseStateOptions) {
  const { settings, updateSettings } = useUserSettingsSlice();
  const [mode, setMode] = useState<LibrarySearchFilterMode>("all");
  const [selectedGenreKey, setSelectedGenreKey] = useState<string | null>(null);
  const [moodFilterIds, setMoodFilterIds] = useState<TrackMoodId[]>([]);
  const [moodMatchMode, setMoodMatchMode] = useState<"any" | "all">("any");

  const endSearchForBrowse = useCallback(() => {
    if (showSearchBar) onSearchBarClose();
  }, [showSearchBar, onSearchBarClose]);

  /** Reset filtri locali al "home" libreria; libBrowse è già impostato da AppShell. */
  useEffect(() => {
    if (libraryHomeTick < 1) return;
    startTransition(() => {
      setSelectedGenreKey(null);
      setMoodFilterIds([]);
      setMoodMatchMode("any");
      setMode("all");
    });
  }, [libraryHomeTick]);

  useEffect(() => {
    const raw = window.location.pathname.replace(/^\/+/, "").split("/")[0];
    if (raw !== "nebula") return;
    updateSettings({ libBrowse: "nebula" });
    window.history.replaceState({}, "", "/libreria");
  }, [updateSettings]);

  return {
    libBrowse: settings.libBrowse,
    libOverviewSort: settings.libOverviewSort,
    artistAlbumSort: settings.artistAlbumSort,
    mode,
    setMode,
    selectedGenreKey,
    setSelectedGenreKey,
    moodFilterIds,
    setMoodFilterIds,
    moodMatchMode,
    setMoodMatchMode,
    endSearchForBrowse,
  };
}
