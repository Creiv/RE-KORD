/**
 * Library quality ("Alert qualità" / "Da sistemare"): what needs fixing in the
 * account's library, with the hub's definitions (`crates/core/src/db/quality.rs`)
 * so the dashboard tile, the hub stats and the lists agree:
 *
 * - album without cover: not a loose-tracks folder, no cover;
 * - album without metadata: not loose, no album metadata applied and no
 *   release date / label / country (`albumHasAlbumMeta`);
 * - track without metadata: no real genre and no release date
 *   (`trackHasFileMeta`; "Unknown" or "8" is not a genre);
 * - loose album: a folder of loose tracks (informational).
 *
 * Everything is computed from the account's own catalog (`tracks-page`, already
 * filtered by its library selection): an album counts only when one of its
 * tracks is in the catalog.
 */
import type { Album, Track } from "./api";
import { albumHasAlbumMeta, trackHasFileMeta } from "./trackMoods";

export const QUALITY_ISSUES = [
  "albums-without-cover",
  "albums-without-meta",
  "tracks-without-meta",
  "loose-albums",
] as const;

export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export type QualityCounts = {
  albumsWithoutCover: number;
  albumsWithoutMeta: number;
  tracksWithoutMeta: number;
  looseAlbums: number;
};

export type QualityLists = {
  "albums-without-cover": Album[];
  "albums-without-meta": Album[];
  "tracks-without-meta": Track[];
  "loose-albums": Album[];
};

export function albumMissingCover(album: Pick<Album, "loose" | "has_cover">): boolean {
  return !album.loose && !album.has_cover;
}

export function albumMissingMeta(album: Album): boolean {
  return !album.loose && !albumHasAlbumMeta(album);
}

export function trackMissingMeta(track: Pick<Track, "genre" | "release_date">): boolean {
  return !trackHasFileMeta(track);
}

/** Albums of the account: those with at least one track in its catalog. */
export function ownAlbums(albums: readonly Album[], catalog: readonly Track[]): Album[] {
  const mine = new Set<number>();
  for (const tr of catalog) if (tr.album_id != null) mine.add(tr.album_id);
  return albums.filter((a) => mine.has(a.id));
}

/** Counters only (one pass, no lists): the dashboard tile and card. */
export function qualityCountsOf(albums: readonly Album[], catalog: readonly Track[]): QualityCounts {
  const out: QualityCounts = { albumsWithoutCover: 0, albumsWithoutMeta: 0, tracksWithoutMeta: 0, looseAlbums: 0 };
  for (const a of ownAlbums(albums, catalog)) {
    if (a.loose) out.looseAlbums += 1;
    else {
      if (albumMissingCover(a)) out.albumsWithoutCover += 1;
      if (albumMissingMeta(a)) out.albumsWithoutMeta += 1;
    }
  }
  for (const tr of catalog) if (trackMissingMeta(tr)) out.tracksWithoutMeta += 1;
  return out;
}

/** Issues that count towards the dashboard total (loose folders are informational). */
export function qualityTotal(c: QualityCounts): number {
  return c.albumsWithoutCover + c.albumsWithoutMeta + c.tracksWithoutMeta;
}

/**
 * The lists behind the counters, sorted by artist, album, then disc / track
 * number. Built when the "Da sistemare" dialog opens, not on every render.
 */
export function qualityLists(
  albums: readonly Album[],
  catalog: readonly Track[],
  locale?: string,
): QualityLists {
  const cmp = (a: string, b: string) => a.localeCompare(b, locale, { numeric: true, sensitivity: "base" });
  const byAlbum = (a: Album, b: Album) => cmp(a.artist_name, b.artist_name) || cmp(a.name, b.name) || a.id - b.id;
  const own = ownAlbums(albums, catalog).sort(byAlbum);
  const tracks = catalog
    .filter(trackMissingMeta)
    .sort(
      (a, b) =>
        cmp(a.artist_name, b.artist_name) ||
        cmp(a.album_name, b.album_name) ||
        (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
        (a.track_number ?? 0) - (b.track_number ?? 0) ||
        cmp(a.title, b.title),
    );
  return {
    "albums-without-cover": own.filter(albumMissingCover),
    "albums-without-meta": own.filter(albumMissingMeta),
    "tracks-without-meta": tracks,
    "loose-albums": own.filter((a) => a.loose),
  };
}

/** `QualityCounts` field of each issue (tab badges, card rows). */
export function countOf(c: QualityCounts, issue: QualityIssue): number {
  switch (issue) {
    case "albums-without-cover":
      return c.albumsWithoutCover;
    case "albums-without-meta":
      return c.albumsWithoutMeta;
    case "tracks-without-meta":
      return c.tracksWithoutMeta;
    case "loose-albums":
      return c.looseAlbums;
  }
}
