import type { LibraryIndex, LibraryTrackIndex } from "../types"
import { hasParsedGenre, parseTrackGenres, serializeTrackGenres } from "./genres"

export type GenreAutoSource = "album" | "artist"

export type GenreAutoAssignment = {
  relPath: string
  /** Valore da passare a save `genre` (un solo genere canonico). */
  genreSerialized: string
  source: GenreAutoSource
  support: number
  total: number
  confidence: number
}

type VoteRow = { key: string; label: string; n: number }

function genreKey(label: string): string {
  const raw = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
  if (!raw) return ""
  if (raw === "rnb" || raw === "r n b" || raw === "r and b" || raw === "rhythm and blues")
    return "r&b"
  if (raw === "hiphop" || raw === "hip hop") return "hip hop"
  if (raw === "drum n bass" || raw === "drum and bass" || raw === "dnb") return "drum and bass"
  if (raw === "synth pop" || raw === "synthpop") return "synth pop"
  return raw
}

function addGenreTokensToCounts(
  raw: string | null | undefined,
  into: Map<string, VoteRow>,
) {
  for (const g of parseTrackGenres(raw)) {
    const key = genreKey(g)
    if (!key) continue
    const prev = into.get(key)
    if (prev) prev.n += 1
    else into.set(key, { key, label: g, n: 1 })
  }
}

function buildGlobalGenreSupport(index: LibraryIndex): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of index.tracks) {
    for (const g of parseTrackGenres(t.meta?.genre)) {
      const k = genreKey(g)
      if (!k) continue
      m.set(k, (m.get(k) ?? 0) + 1)
    }
  }
  return m
}

function pickWinner(
  counts: Map<string, VoteRow>,
  global: Map<string, number>,
): VoteRow | null {
  let best: VoteRow | null = null
  for (const v of counts.values()) {
    if (!best) {
      best = v
      continue
    }
    if (v.n > best.n) {
      best = v
      continue
    }
    if (v.n < best.n) continue
    const ga = global.get(v.key) ?? 0
    const gb = global.get(best.key) ?? 0
    if (ga > gb) best = v
    else if (ga === gb && v.label.localeCompare(best.label, undefined, { sensitivity: "base" }) < 0)
      best = v
  }
  return best
}

function shouldTrustWinner(source: GenreAutoSource, winner: VoteRow, totalTagged: number): boolean {
  if (totalTagged <= 0) return false
  const confidence = winner.n / totalTagged
  if (source === "album") {
    return confidence === 1 || winner.n >= 2 || confidence >= 0.67
  }
  return confidence === 1 || (winner.n >= 2 && confidence >= 0.6)
}

function assignmentForTrack(
  t: LibraryTrackIndex,
  winner: VoteRow,
  source: GenreAutoSource,
  totalTagged: number,
): GenreAutoAssignment | null {
  const genreSerialized = serializeTrackGenres([winner.label])
  if (!genreSerialized) return null
  const confidence = totalTagged > 0 ? winner.n / totalTagged : 0
  return {
    relPath: t.relPath,
    genreSerialized,
    source,
    support: winner.n,
    total: totalTagged,
    confidence,
  }
}

export type GenreAutoScope = "missing" | "all"

/**
 * Propone un genere da copiare per maggioranza da album poi artista:
 * - **missing**: solo brani ancora senza genere parsabile in kord-trackinfo;
 * - **all**: stesso inferenza ma applicata a tutti i brani dell’album / gruppo artista (sovrascrive il genere).
 */
export function computeGenreAutoAssignments(
  index: LibraryIndex,
  opts?: { scope?: GenreAutoScope },
): GenreAutoAssignment[] {
  const scope = opts?.scope ?? "missing"
  const global = buildGlobalGenreSupport(index)
  const out: GenreAutoAssignment[] = []
  const albumAssigned = new Set<string>()

  const byAlbum = new Map<string, LibraryTrackIndex[]>()
  for (const t of index.tracks) {
    const id = t.albumId || `__solo__${t.relPath}`
    let a = byAlbum.get(id)
    if (!a) {
      a = []
      byAlbum.set(id, a)
    }
    a.push(t)
  }

  for (const tracks of byAlbum.values()) {
    const tagged = tracks.filter((t) => hasParsedGenre(t.meta?.genre))
    const empty = tracks.filter((t) => !hasParsedGenre(t.meta?.genre))
    if (!tagged.length) continue
    if (scope === "missing" && !empty.length) continue
    const counts = new Map<string, VoteRow>()
    for (const t of tagged) addGenreTokensToCounts(t.meta?.genre, counts)
    const winner = pickWinner(counts, global)
    if (!winner) continue
    if (!shouldTrustWinner("album", winner, tagged.length)) continue
    const targets = scope === "all" ? tracks : empty
    if (!targets.length) continue
    for (const t of targets) {
      const row = assignmentForTrack(t, winner, "album", tagged.length)
      if (!row) continue
      out.push(row)
      albumAssigned.add(t.relPath)
    }
  }

  const byArtist = new Map<string, LibraryTrackIndex[]>()
  for (const t of index.tracks) {
    const ar = t.artist || "—"
    let g = byArtist.get(ar)
    if (!g) {
      g = []
      byArtist.set(ar, g)
    }
    g.push(t)
  }

  for (const tracks of byArtist.values()) {
    const tagged = tracks.filter((t) => hasParsedGenre(t.meta?.genre))
    const empty = tracks.filter(
      (t) =>
        !hasParsedGenre(t.meta?.genre) && !albumAssigned.has(t.relPath),
    )
    const rest = tracks.filter((t) => !albumAssigned.has(t.relPath))
    const targets = scope === "all" ? rest : empty
    if (!tagged.length || !targets.length) continue
    const counts = new Map<string, VoteRow>()
    for (const t of tagged) addGenreTokensToCounts(t.meta?.genre, counts)
    const winner = pickWinner(counts, global)
    if (!winner) continue
    if (!shouldTrustWinner("artist", winner, tagged.length)) continue
    for (const t of targets) {
      const row = assignmentForTrack(t, winner, "artist", tagged.length)
      if (row) out.push(row)
    }
  }

  const seen = new Set<string>()
  return out.filter((r) => {
    if (seen.has(r.relPath)) return false
    seen.add(r.relPath)
    return true
  })
}
