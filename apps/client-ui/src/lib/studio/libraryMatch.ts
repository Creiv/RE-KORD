/**
 * "Already in the library" for Studio download results (Esplora, Scopri,
 * classic preview). Pure, so `node --test` can cover it.
 *
 * Titles and artists are compared after folding (accents, case, spacing),
 * dropping punctuation and the decorations stores add to the same release:
 * "(Deluxe Edition)", "[Remastered 2011]", "- EP", "- Single", "(feat. …)".
 * Artists match when any credited name matches ("A, B e C" vs "B").
 */
import { foldText, stripTrackNumberPrefix } from "../search";

/** Words that mark a bracket / dash suffix as edition noise, not part of the title. */
const EDITION_WORDS =
  "deluxe|super deluxe|remaster(?:ed)?|expanded|edition|anniversary|bonus|explicit|clean|" +
  "reissue|album version|single version|anniversario|rimasterizzat[oa]|edizione|ausgabe|" +
  "remasterisiert|ep|single|singolo|official audio|official video|official music video|" +
  "audio|lyrics?|lyric video|visualizer|mono|stereo";

/** "(feat. X)", "[with X]", "(con X)" — and a bare trailing "feat. X". */
const FEAT_BRACKET_RE = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|con|mit)\s+[^)\]]*[)\]]/gi;
const FEAT_TAIL_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const BRACKET_RE = /\s*[([{]([^)\]}]*)[)\]}]/g;
const EDITION_RE = new RegExp(`\\b(?:${EDITION_WORDS})\\b`, "i");
const DASH_SUFFIX_RE = new RegExp(`\\s+[-–—]\\s+(?:[^-–—]*\\b(?:${EDITION_WORDS})\\b[^-–—]*)$`, "i");

function stripPunctuation(s: string): string {
  return s
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Album or song title without edition / featuring noise. */
export function normalizeReleaseTitle(raw: string | null | undefined): string {
  let s = foldText(stripTrackNumberPrefix(String(raw ?? "")));
  if (!s) return "";
  s = s.replace(FEAT_BRACKET_RE, " ").replace(FEAT_TAIL_RE, "");
  // Brackets: drop the ones that only describe the edition.
  s = s.replace(BRACKET_RE, (whole, inner: string) => (EDITION_RE.test(inner) ? " " : whole));
  // "Title - EP", "Title - 2011 Remaster", "Title - Single".
  for (let i = 0; i < 3; i++) {
    const next = s.replace(DASH_SUFFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  const out = stripPunctuation(s);
  // Never fold a title down to nothing ("(Live)" alone stays a title).
  return out || stripPunctuation(foldText(String(raw ?? "")));
}

/** Credited names, folded: "SLVSHY, CLE4VER e DJ BEATCOIN" → 3 names. */
export function splitArtists(raw: string | null | undefined): string[] {
  let s = foldText(String(raw ?? ""));
  if (!s) return [];
  s = s.replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]*)[)\]]/g, ", $1");
  const parts = s
    .split(/\s*(?:,|;|\/|&|\+|\bx\b|\band\b|\be\b|\bund\b|\by\b|\bet\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/)
    .map((p) => stripPunctuation(p).replace(/^the /, ""))
    .filter(Boolean);
  const whole = stripPunctuation(s).replace(/^the /, "");
  // The full string too: "Simon and Garfunkel" is one act.
  return [...new Set(whole ? [whole, ...parts] : parts)];
}

/**
 * Artist of a YouTube Music result from its subtitle
 * ("Album • Linkin Park • 2007", "Singolo • MADE e ISO", "Brano • Numb").
 */
export function artistFromSubtitle(subtitle: string | null | undefined): string {
  const segs = String(subtitle ?? "")
    .split(/\s+[•·]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segs.length >= 2 ? segs[1]! : "";
}

export type LibraryAlbumLike = { name: string; artist_name: string; folder_key?: string; folder_name?: string | null };
export type LibraryTrackLike = { title: string; artist_name: string };

export type LibraryIndex = {
  /** title key → artist names of the albums with that title. */
  albums: Map<string, { artists: string[]; folder: string }[]>;
  songs: Map<string, string[][]>;
};

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildLibraryIndex(
  albums: readonly LibraryAlbumLike[],
  tracks: readonly LibraryTrackLike[],
): LibraryIndex {
  const idx: LibraryIndex = { albums: new Map(), songs: new Map() };
  for (const a of albums) {
    const artists = splitArtists(a.artist_name);
    const folder = a.folder_key ?? "";
    const keys = new Set([normalizeReleaseTitle(a.name), normalizeReleaseTitle(a.folder_name)]);
    for (const k of keys) push(idx.albums, k, { artists, folder });
  }
  for (const t of tracks) {
    push(idx.songs, normalizeReleaseTitle(t.title), splitArtists(t.artist_name));
  }
  return idx;
}

function artistsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

/** Folder key of the matching library album, or null. An empty artist matches nothing. */
export function matchLibraryAlbum(idx: LibraryIndex, artist: string, title: string): string | null {
  const rows = idx.albums.get(normalizeReleaseTitle(title));
  if (!rows) return null;
  const artists = splitArtists(artist);
  const hit = rows.find((r) => artistsOverlap(r.artists, artists));
  return hit ? hit.folder || hit.artists[0] || "" : null;
}

export function matchLibrarySong(idx: LibraryIndex, artist: string, title: string): boolean {
  const rows = idx.songs.get(normalizeReleaseTitle(title));
  if (!rows) return false;
  const artists = splitArtists(artist);
  return rows.some((r) => artistsOverlap(r, artists));
}

export type LibraryHit = { kind: "album" | "song"; folder?: string };

/**
 * One Studio result. `kind` "album" for albums / EPs / playlists, "song" for
 * tracks; the artist comes from `artist` or, failing that, the subtitle.
 * A song whose title is an album in the library ("Exuvia" the single) is not
 * flagged as the album.
 */
export function libraryHitFor(
  idx: LibraryIndex,
  item: { kind: "album" | "song"; title: string; subtitle?: string | null; artist?: string | null },
): LibraryHit | null {
  const artist = item.artist?.trim() || artistFromSubtitle(item.subtitle);
  if (!artist) return null;
  if (item.kind === "album") {
    const folder = matchLibraryAlbum(idx, artist, item.title);
    return folder != null ? { kind: "album", folder } : null;
  }
  return matchLibrarySong(idx, artist, item.title) ? { kind: "song" } : null;
}
