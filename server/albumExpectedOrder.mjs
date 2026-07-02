/** Nome file locale del brano (ordine di download / cartella). */
function trackFileName(track) {
  const fromMeta = track?.meta?.fileName
  if (fromMeta) return String(fromMeta)
  const rel = String(track?.relPath || "")
  const slash = rel.lastIndexOf("/")
  return slash >= 0 ? rel.slice(slash + 1) : rel
}

/**
 * Ordine di visualizzazione: solo nome file su disco (ordine tipico del download).
 * Non usa trackNumber, releaseDate né expectedTracks da metadati scaricati.
 */
function compareAlbumTracksByFileName(a, b) {
  const cmp = trackFileName(a).localeCompare(trackFileName(b), undefined, {
    numeric: true,
    sensitivity: "base",
  })
  if (cmp !== 0) return cmp
  const aa = Number(a?.addedAt ?? a?.meta?.mtime ?? 0)
  const bb = Number(b?.addedAt ?? b?.meta?.mtime ?? 0)
  if (aa !== bb) return aa - bb
  return String(a?.relPath || "").localeCompare(String(b?.relPath || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  })
}

/**
 * Ordina i brani di un album per nome file (ordine download).
 * @param {Array<{ title: string, relPath?: string, meta?: object, addedAt?: number | null }>} tracks
 */
export function orderAlbumTrackList(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 1) return []
  if (tracks.length < 2) return [...tracks]
  return [...tracks].sort(compareAlbumTracksByFileName)
}
