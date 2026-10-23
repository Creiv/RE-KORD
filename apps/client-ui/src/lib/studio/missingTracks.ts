/**
 * Which tracks of a release are not in the library album yet (GitHub issue
 * #100: "scan for missing tracks"). Titles are compared folded, without
 * numbering, edition or featuring noise (`normalizeReleaseTitle`), so
 * "03 - Song (feat. X)" on disk matches "Song" on the release page. Pure, so
 * `node --test` covers it.
 */
import { normalizeReleaseTitle } from "./libraryMatch";

export type ReleaseTrackLike = { title: string; url: string };
export type LibraryTrackTitleLike = { title: string; track_number?: number | null };

export type MissingTrack = {
  /** 1-based position on the release. */
  index: number;
  title: string;
  url: string;
};

export function missingReleaseTracks(
  release: readonly ReleaseTrackLike[],
  library: readonly LibraryTrackTitleLike[],
): MissingTrack[] {
  const have = new Set<string>();
  for (const t of library) {
    const k = normalizeReleaseTitle(t.title);
    if (k) have.add(k);
  }
  const out: MissingTrack[] = [];
  release.forEach((r, i) => {
    const k = normalizeReleaseTitle(r.title);
    if (!k || !have.has(k)) out.push({ index: i + 1, title: r.title, url: r.url });
  });
  return out;
}
