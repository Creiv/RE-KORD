/** Cartella album su disco per un brano (gestisce album loose "Tracks"). */
import { isLooseAlbumName } from "./libraryNav"

export function albumFolderFromTrackRelPath(
  relPath: string,
  opts?: { filePath?: string | null; albumFolderRelPath?: string | null },
): string {
  if (opts?.albumFolderRelPath?.trim()) {
    return opts.albumFolderRelPath.trim()
  }
  const parts = relPath.split("/").filter(Boolean)
  if (parts.length < 2) return ""
  if (parts.length >= 3 && isLooseAlbumName(parts[1]) && opts?.filePath) {
    const fp = opts.filePath.split("/").filter(Boolean)
    fp.pop()
    return fp.join("/")
  }
  parts.pop()
  return parts.join("/")
}

export function albumFolderFromTrack(track: {
  relPath: string
  filePath?: string | null
  albumFolderRelPath?: string | null
}): string {
  return albumFolderFromTrackRelPath(track.relPath, {
    filePath: track.filePath,
    albumFolderRelPath: track.albumFolderRelPath,
  })
}
