function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "")
    .replace(/^\d+[\s._-]*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * @param {string} fileName
 * @param {string} titleRaw
 * @param {string} artist unused, kept for call-site parity
 * @param {Array<{ title?: string, position?: number|null, disc?: number, durationMs?: number|null }>} tracklist
 * @param {string} [titlePrepared] optional cleaned title from prepareTrackTitleForMeta
 */
export function matchTrackToDiscogsEntry(
  fileName,
  titleRaw,
  artist,
  tracklist,
  titlePrepared,
) {
  void artist
  const title = titlePrepared || titleRaw || fileName
  const nFile = normTitle(title)
  if (!nFile || !Array.isArray(tracklist)) return null

  let best = null
  let bestScore = 0
  for (let i = 0; i < tracklist.length; i += 1) {
    const row = tracklist[i]
    const nRow = normTitle(row?.title)
    if (!nRow) continue
    let score = 0
    if (nFile === nRow) score = 100
    else if (nFile.includes(nRow) || nRow.includes(nFile)) score = 70
    else {
      const overlap = nFile.split(" ").filter((t) => nRow.split(" ").includes(t))
      score = overlap.length * 15
    }
    if (Number.isFinite(Number(row.position))) {
      const stem = fileName.replace(/\.[^.]+$/, "")
      const lead = Number(String(stem).match(/^(\d+)/)?.[1])
      if (Number.isFinite(lead) && lead === Number(row.position)) score += 20
    }
    if (score > bestScore) {
      bestScore = score
      best = { row, index: i }
    }
  }
  return bestScore >= 40 ? best : null
}
