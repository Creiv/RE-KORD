export type StudioDownloadScope = "single" | "playlist";

export function normalizeDownloadDestPath(value: string | null | undefined) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function isValidDownloadDestPath(value: string | null | undefined) {
  return normalizeDownloadDestPath(value).length > 0;
}

export function relPathLooksLikeAlbumFolderDest(relPath: string | null | undefined) {
  return normalizeDownloadDestPath(relPath).split("/").filter(Boolean).length >= 2;
}

export function joinMusicDestRelPath(base: string, title: string): string {
  const b = normalizeDownloadDestPath(base);
  const seg = normalizeDownloadDestPath(
    title.replace(/[/\\]+/g, " ").replace(/\s+/g, " ").trim(),
  );
  return b && seg ? `${b}/${seg}` : seg || b;
}

export function studioDownloadKindForScope(scope: StudioDownloadScope): string {
  return scope === "single" ? "download_single" : "download_playlist";
}

/**
 * Cartella di output per yt-dlp.
 * Playlist/album sotto cartella artista → sottocartella col titolo.
 * Singolo → destinazione scelta così com'è (cartella album).
 */
export function resolveStudioDownloadOutputDir(
  dlPath: string,
  scope: StudioDownloadScope,
  releaseTitle?: string,
): string {
  const norm = normalizeDownloadDestPath(dlPath);
  if (
    scope === "playlist" &&
    releaseTitle?.trim() &&
    !relPathLooksLikeAlbumFolderDest(norm)
  ) {
    return joinMusicDestRelPath(norm, releaseTitle);
  }
  return norm;
}

export function buildStudioDownloadConfirm(args: {
  dlPath: string;
  scope: StudioDownloadScope;
  releaseTitle?: string;
  trackCount?: number | null;
  preamble?: string;
}): { variant: "danger" | "warning"; message: string } {
  const pickedNorm = normalizeDownloadDestPath(args.dlPath);
  const outputDir = resolveStudioDownloadOutputDir(
    args.dlPath,
    args.scope,
    args.releaseTitle,
  );
  const artistFolderTarget =
    args.scope === "single"
      ? !relPathLooksLikeAlbumFolderDest(pickedNorm)
      : !relPathLooksLikeAlbumFolderDest(outputDir);

  let msg = args.preamble?.trim() ?? "";
  if (msg) msg += "\n\n";
  msg += artistFolderTarget
    ? `Scaricare in cartella artista «${outputDir}»?\nI file andranno direttamente lì.`
    : `Scaricare i brani in «${outputDir}»?`;
  if (
    args.scope === "playlist" &&
    args.trackCount != null &&
    args.trackCount > 0
  ) {
    msg += `\n\nBrani previsti: ${args.trackCount}.`;
  }
  return {
    variant: artistFolderTarget ? "danger" : "warning",
    message: msg,
  };
}
