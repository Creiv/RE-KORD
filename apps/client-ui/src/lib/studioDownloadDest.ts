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
 * Output folder for yt-dlp.
 * Playlist/album under an artist folder → subfolder named after the title.
 * Single → chosen destination as is (album folder).
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

/** Translator injected by the caller (`t` from i18n), so this stays testable in node. */
export type ConfirmTranslate = (key: string, vars?: Record<string, string | number>) => string;

export function buildStudioDownloadConfirm(
  args: {
    dlPath: string;
    scope: StudioDownloadScope;
    releaseTitle?: string;
    trackCount?: number | null;
    preamble?: string;
  },
  tr: ConfirmTranslate,
): { variant: "danger" | "warning"; message: string } {
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
    ? tr("studio.dl.confirmArtistFolder", { path: outputDir })
    : tr(
        args.scope === "single" || args.trackCount === 1
          ? "studio.dl.confirmAlbumFolder.one"
          : "studio.dl.confirmAlbumFolder.other",
        { path: outputDir },
      );
  if (
    args.scope === "playlist" &&
    args.trackCount != null &&
    args.trackCount > 0
  ) {
    msg += `\n\n${tr("studio.dl.confirmTrackCount", { n: args.trackCount })}`;
  }
  return {
    variant: artistFolderTarget ? "danger" : "warning",
    message: msg,
  };
}
