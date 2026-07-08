import { useEffect } from "react";
import { useToolsActivity } from "../../../context/ToolsActivityContext";
import { useLibrarySyncActivity } from "../../../context/LibrarySyncActivityContext";

/** Registers studio tool busy flags with global library sync activity. */
export function useStudioLibrarySync() {
  const librarySync = useLibrarySyncActivity();
  const {
    dlBusy,
    metaBusy,
    metaAllBusy,
    trackMetaBusy,
    trackAllBusy,
    artBusy,
    titleSanBusy,
    trackPruneBusy,
  } = useToolsActivity();

  useEffect(() => {
    if (!dlBusy) return;
    return librarySync.beginActivity("sync.activity.downloading");
  }, [dlBusy, librarySync]);

  useEffect(() => {
    if (!metaBusy) return;
    return librarySync.beginActivity("sync.activity.fetchAlbumMeta");
  }, [metaBusy, librarySync]);

  useEffect(() => {
    if (!metaAllBusy) return;
    return librarySync.beginActivity("sync.activity.scanAlbumMeta");
  }, [metaAllBusy, librarySync]);

  useEffect(() => {
    if (!trackMetaBusy) return;
    return librarySync.beginActivity("sync.activity.fetchTrackMeta");
  }, [trackMetaBusy, librarySync]);

  useEffect(() => {
    if (!trackAllBusy) return;
    return librarySync.beginActivity("sync.activity.scanTrackMeta");
  }, [trackAllBusy, librarySync]);

  useEffect(() => {
    if (!artBusy) return;
    return librarySync.beginActivity("sync.activity.applyingCover");
  }, [artBusy, librarySync]);

  useEffect(() => {
    if (!titleSanBusy) return;
    return librarySync.beginActivity("sync.activity.sanitizingTitles");
  }, [titleSanBusy, librarySync]);

  useEffect(() => {
    if (!trackPruneBusy) return;
    return librarySync.beginActivity("sync.activity.pruningTrackMeta");
  }, [trackPruneBusy, librarySync]);
}
