import { discogsFetch } from "./discogsClient.mjs"
import { normalizeStoredGenreString } from "./genres.mjs"

const NON_MUSIC_FORMAT_RE =
  /\b(dvd|blu-?ray|vhs|umd|interview|documentary|book|poster|merch)\b/i

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokenOverlap(a, b) {
  const ta = new Set(norm(a).split(/\s+/).filter((x) => x.length > 1))
  const tb = new Set(norm(b).split(/\s+/).filter((x) => x.length > 1))
  if (!ta.size || !tb.size) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit += 1
  return hit / Math.max(ta.size, tb.size)
}

/** @param {string} dur e.g. "3:32" */
export function parseDiscogsDurationMs(dur) {
  const s = String(dur || "").trim()
  if (!s) return null
  const parts = s.split(":").map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
  return null
}

function formatSummary(formats) {
  if (!Array.isArray(formats) || !formats.length) return null
  return formats
    .map((f) => {
      const name = f?.name ? String(f.name) : ""
      const desc = Array.isArray(f?.descriptions) ? f.descriptions.join(", ") : ""
      const qty = f?.qty && f.qty !== "1" ? ` x${f.qty}` : ""
      return [name, desc].filter(Boolean).join(", ") + qty
    })
    .filter(Boolean)
    .join(" · ")
    .slice(0, 300) || null
}

function primaryBarcode(identifiers) {
  if (!Array.isArray(identifiers)) return null
  const row = identifiers.find((i) => String(i?.type || "").toLowerCase() === "barcode")
  return row?.value ? String(row.value).trim().slice(0, 64) : null
}

function catalogFromRelease(release) {
  const labels = release?.labels
  if (!Array.isArray(labels) || !labels.length) return null
  const cat = labels[0]?.catno
  return cat ? String(cat).trim().slice(0, 120) : null
}

function labelFromRelease(release) {
  const labels = release?.labels
  if (!Array.isArray(labels) || !labels.length) return null
  return labels[0]?.name ? String(labels[0].name).trim().slice(0, 300) : null
}

function genresFromRelease(release) {
  const genres = Array.isArray(release?.genres) ? release.genres : []
  const styles = Array.isArray(release?.styles) ? release.styles : []
  const merged = [...genres, ...styles].map((g) => String(g).trim()).filter(Boolean)
  if (!merged.length) return null
  return normalizeStoredGenreString(merged.join(", ")) || merged.join(", ")
}

function tracklistFromRelease(release) {
  const list = Array.isArray(release?.tracklist) ? release.tracklist : []
  const tracks = []
  for (const row of list) {
    if (!row || row.type_ === "heading") continue
    const title = row.title != null ? String(row.title).trim() : ""
    if (!title) continue
    const pos = row.position != null ? String(row.position).trim() : ""
    const disc = Number.isFinite(Number(row.disc)) ? Number(row.disc) : 1
    let position = null
    const n = Number(pos)
    if (Number.isFinite(n)) position = n
    tracks.push({
      disc,
      position,
      title,
      durationMs: parseDiscogsDurationMs(row.duration),
    })
  }
  return tracks
}

/**
 * @param {Record<string, unknown>} result search result row
 * @param {string} artist
 * @param {string} album
 */
export function scoreDiscogsCandidate(result, artist, album) {
  let score = 0
  const title = String(result?.title || "")
  const type = String(result?.type || "")
  if (type === "release") score += 8
  else if (type === "master") score += 4

  const artistScore = tokenOverlap(
    artist,
    Array.isArray(result?.artist) ? result.artist.join(" ") : String(result?.artist || title),
  )
  score += artistScore * 40

  const albumPart = title.includes(" - ") ? title.split(" - ").slice(1).join(" - ") : title
  score += tokenOverlap(album, albumPart) * 50

  const fmt = Array.isArray(result?.format) ? result.format.join(" ") : String(result?.format || "")
  if (NON_MUSIC_FORMAT_RE.test(fmt)) score -= 25

  const year = Number(result?.year)
  if (Number.isFinite(year) && year > 1900 && year < 2100) score += 3

  return Math.round(score * 10) / 10
}

/**
 * @param {Record<string, unknown>} release full release JSON
 * @param {Record<string, unknown> | null} [stats] marketplace stats
 */
export function normalizeDiscogsRelease(release, stats = null) {
  if (!release || !release.id) return { error: "Invalid release" }

  const artists = Array.isArray(release.artists) ? release.artists : []
  const primaryArtist = artists[0]
  const expectedTracks = tracklistFromRelease(release)
  const community = release.community || {}
  const rating = community.rating || {}

  const discogsExtra = {
    masterId: release.master_id ?? null,
    discogsUri: release.uri || release.resource_url || null,
    discogsArtistId: primaryArtist?.id ?? null,
    styles: Array.isArray(release.styles) ? release.styles : [],
    formats: Array.isArray(release.formats) ? release.formats : [],
    formatSummary: formatSummary(release.formats),
    catalogNo: catalogFromRelease(release),
    barcode: primaryBarcode(release.identifiers),
    notes:
      typeof release.notes === "string"
        ? release.notes.trim().slice(0, 4000)
        : null,
    identifiers: Array.isArray(release.identifiers) ? release.identifiers.slice(0, 20) : [],
    videos: Array.isArray(release.videos) ? release.videos.slice(0, 8) : [],
    community: {
      have: community.have ?? null,
      want: community.want ?? null,
      rating: {
        average: rating.average ?? null,
        count: rating.count ?? null,
      },
    },
    marketplace: stats
      ? {
          lowestPrice: stats.lowest_price?.value ?? stats.lowest_price ?? null,
          currency: stats.lowest_price?.currency ?? null,
          numForSale: stats.num_for_sale ?? null,
          blockedFromSale: stats.blocked_from_sale ?? false,
        }
      : {
          lowestPrice: release.lowest_price ?? null,
          currency: null,
          numForSale: release.num_for_sale ?? null,
          blockedFromSale: false,
        },
  }

  const year = release.year || release.released
  const releaseDate = year ? String(year).slice(0, 64) : null

  return {
    ok: true,
    source: "discogs",
    discogsReleaseId: Number(release.id),
    discogsUri: discogsExtra.discogsUri,
    discogsArtistId: discogsExtra.discogsArtistId,
    title: release.title ? String(release.title).trim() : null,
    releaseDate,
    date: releaseDate,
    country: release.country ? String(release.country).trim().slice(0, 64) : null,
    label: labelFromRelease(release),
    genre: genresFromRelease(release),
    catalogNo: discogsExtra.catalogNo,
    barcode: discogsExtra.barcode,
    formatSummary: discogsExtra.formatSummary,
    expectedTracks: expectedTracks.length ? expectedTracks : undefined,
    expectedTrackCount: expectedTracks.length || undefined,
    discogsExtra,
  }
}

/**
 * @param {string} artist
 * @param {string} album
 * @param {{ limit?: number }} [opts]
 */
export async function searchDiscogsReleases(artist, album, opts = {}) {
  const a = String(artist || "").trim()
  const b = String(album || "").trim()
  if (a.length < 1 && b.length < 1) return { error: "Artist or album missing" }

  const limit = Math.min(Math.max(Number(opts.limit) || 5, 1), 10)
  const query = {}
  if (a) query.artist = a
  if (b) query.release_title = b
  query.type = "release"
  query.per_page = String(Math.max(limit * 3, 15))

  let data
  try {
    data = await discogsFetch("/database/search", { query })
  } catch (e) {
    return { error: e?.message || "Discogs search failed" }
  }

  const results = Array.isArray(data?.results) ? data.results : []
  const scored = results
    .map((r) => ({
      ...r,
      score: scoreDiscogsCandidate(r, a, b),
      releaseId: Number(r.id),
    }))
    .filter((r) => Number.isFinite(r.releaseId) && r.releaseId > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)

  const candidates = scored.map((r) => ({
    releaseId: r.releaseId,
    score: r.score,
    title: String(r.title || ""),
    year: r.year != null ? String(r.year) : null,
    country: r.country ? String(r.country) : null,
    format: Array.isArray(r.format) ? r.format.join(", ") : String(r.format || ""),
    label: Array.isArray(r.label) ? r.label.join(", ") : String(r.label || ""),
    catno: r.catno ? String(r.catno) : null,
    thumb: r.thumb ? String(r.thumb) : r.cover_image ? String(r.cover_image) : null,
    uri: r.uri ? `https://www.discogs.com${r.uri}` : null,
    community: {
      have: r.community?.have ?? null,
      want: r.community?.want ?? null,
    },
  }))

  if (!candidates.length) return { error: "No Discogs releases found" }
  return { ok: true, candidates }
}

export async function fetchDiscogsRelease(releaseId) {
  const id = Number(releaseId)
  if (!Number.isFinite(id) || id < 1) return { error: "Invalid release ID" }
  try {
    const release = await discogsFetch(`/releases/${id}`)
    let stats = null
    try {
      stats = await discogsFetch(`/marketplace/stats/${id}`)
    } catch {
      /* optional */
    }
    return normalizeDiscogsRelease(release, stats)
  } catch (e) {
    return { error: e?.message || "Discogs release fetch failed" }
  }
}

export async function fetchDiscogsArtist(artistId) {
  const id = Number(artistId)
  if (!Number.isFinite(id) || id < 1) return { error: "Invalid artist ID" }
  try {
    const data = await discogsFetch(`/artists/${id}`)
    return {
      ok: true,
      id: data.id,
      name: data.name,
      profile: typeof data.profile === "string" ? data.profile.trim() : "",
      uri: data.uri || null,
      images: Array.isArray(data.images) ? data.images : [],
      urls: Array.isArray(data.urls) ? data.urls : [],
    }
  } catch (e) {
    return { error: e?.message || "Discogs artist fetch failed" }
  }
}

/**
 * Merge Discogs payload with fallback sources (fills empty fields only).
 * @param {Record<string, unknown>} primary
 * @param {Record<string, unknown>} fallback
 */
export function mergeReleaseMetadata(primary, fallback) {
  if (!primary?.ok) return fallback?.ok ? fallback : primary
  if (!fallback?.ok) return primary
  const out = { ...primary }
  const pick = (key, altKey) => {
    const v = out[key] ?? (altKey ? out[altKey] : undefined)
    if (v != null && String(v).trim() !== "") return
    const fb = fallback[key] ?? (altKey ? fallback[altKey] : undefined)
    if (fb != null && String(fb).trim() !== "") out[key] = fb
  }
  pick("title")
  pick("releaseDate", "date")
  pick("date", "releaseDate")
  pick("country")
  pick("label")
  pick("genre")
  if (!out.musicbrainzReleaseId && fallback.musicbrainzReleaseId) {
    out.musicbrainzReleaseId = fallback.musicbrainzReleaseId
  }
  if (
    (!Array.isArray(out.expectedTracks) || !out.expectedTracks.length) &&
    Array.isArray(fallback.expectedTracks) &&
    fallback.expectedTracks.length
  ) {
    out.expectedTracks = fallback.expectedTracks
    out.expectedTrackCount = fallback.expectedTrackCount
  }
  return out
}

export async function fetchReleaseMetadataDiscogs(artist, album) {
  const search = await searchDiscogsReleases(artist, album, { limit: 1 })
  if (!search.ok || !search.candidates?.length) {
    return { error: search.error || "No Discogs match" }
  }
  return fetchDiscogsRelease(search.candidates[0].releaseId)
}
