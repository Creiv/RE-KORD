/**
 * One-shot hand-off to a Studio pane: "fix this album" from the dashboard's
 * "Da sistemare" list opens Studio › Copertine or › Metadati with that album
 * already picked. The pane takes the request (and clears it) when it mounts
 * or, if it is already open, as soon as the request arrives.
 */
export type StudioFocusPane = "covers" | "meta";

export const studioFocus = $state<{ pane: StudioFocusPane | null; albumId: number | null }>({
  pane: null,
  albumId: null,
});

export function requestStudioAlbum(pane: StudioFocusPane, albumId: number) {
  studioFocus.pane = pane;
  studioFocus.albumId = albumId;
}

/** The album requested for `pane`, cleared on read; null when there is none. */
export function takeStudioAlbum(pane: StudioFocusPane): number | null {
  if (studioFocus.pane !== pane || studioFocus.albumId == null) return null;
  const id = studioFocus.albumId;
  studioFocus.pane = null;
  studioFocus.albumId = null;
  return id;
}
