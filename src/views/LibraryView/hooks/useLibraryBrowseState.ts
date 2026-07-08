import { startTransition, useCallback, useEffect, useState } from "react";
import { useUserState } from "../../../context/UserStateContext";
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
  const user = useUserState();
  const [mode, setMode] = useState<LibrarySearchFilterMode>("all");
  const [selectedGenreKey, setSelectedGenreKey] = useState<string | null>(null);
  const [moodFilterIds, setMoodFilterIds] = useState<TrackMoodId[]>([]);
  const [moodMatchMode, setMoodMatchMode] = useState<"any" | "all">("any");

  const endSearchForBrowse = useCallback(() => {
    if (showSearchBar) onSearchBarClose();
  }, [showSearchBar, onSearchBarClose]);

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
    user.updateSettings({ libBrowse: "nebula" });
    window.history.replaceState({}, "", "/libreria");
  }, [user]);

  return {
    libBrowse: user.state.settings.libBrowse,
    libOverviewSort: user.state.settings.libOverviewSort,
    artistAlbumSort: user.state.settings.artistAlbumSort,
    user,
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
