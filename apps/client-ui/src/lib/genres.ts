/**
 * Genres: the one place that knows how a `genre` field is written and read.
 *
 * Tags and sidecars write lists in several styles ("Hip Hop; Pop Rap",
 * "Rock/Pop", "Rock, Pop", "Rock | Pop") and the same genre in several
 * spellings ("Hip Hop", "hip-hop", "HipHop"). Everything that groups, counts,
 * filters or matches genres (dashboard chips, statistics, achievements, smart
 * shuffle, search, library) goes through here, so they all agree:
 *
 * - `parseTrackGenres(raw)`  → the tokens of one field (first spelling kept);
 * - `normalizeGenreKey(g)`   → identity of a genre (case/space/hyphen-insensitive);
 * - `canonicalGenreLabel(g)` → the label to show for that identity;
 * - `trackGenres(track, album?)` → canonical labels of a track (prefers the
 *   hub's `genres: string[]` when it sends one).
 */

/** List separators found in tags: `;` (our canonical), `/`, `,` and `|`. */
const SPLIT_RE = /\s*[;/,|\0]\s*/;

/** Junk tokens left by taggers: "8", "(12)", "2019"... */
const NUMERIC_ONLY_RE = /^\(?\d+\)?$/;

/** Placeholder "genres" (hub `is_stub_genre`). */
const STUB_GENRES = new Set([
  "music",
  "unknown",
  "other",
  "misc",
  "miscellaneous",
  "various",
  "none",
  "n/a",
  "na",
  "undefined",
  "genre",
  "null",
  "unclassified",
]);

/**
 * Identity of a genre, the same as the hub's (`db::text::genre_key`, and the
 * `key` of `GET /library/genres`): lowercase, accents folded, whitespace and
 * `- _ . '` dropped. "Hip Hop", "hip-hop" and "HipHop" share one key.
 */
export function normalizeGenreKey(raw: string | null | undefined): string {
  if (raw == null) return "";
  return String(raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .toLowerCase()
    .replace(/[\s\-_.'’]+/g, "");
}

/** Spellings that vary between providers, by key (hub `metadata::genres::CANONICAL`). */
const KNOWN_LABELS: Record<string, string> = {
  hiphop: "Hip Hop",
  rap: "Rap",
  rnb: "R&B",
  "r&b": "R&B",
  randb: "R&B",
  rhythmandblues: "R&B",
  "rhythm&blues": "R&B",
  poprock: "Pop Rock",
  electronic: "Electronic",
  electronica: "Electronica",
  edm: "EDM",
  dancepop: "Dance Pop",
  synthpop: "Synth-pop",
  triphop: "Trip Hop",
  lofi: "Lo-Fi",
  lofihiphop: "Lo-Fi Hip Hop",
  drumandbass: "Drum and Bass",
  "drum&bass": "Drum and Bass",
  drumnbass: "Drum and Bass",
  dnb: "Drum and Bass",
  kpop: "K-Pop",
  jpop: "J-Pop",
  altrock: "Alternative Rock",
  alternativerock: "Alternative Rock",
  alternative: "Alternative",
  indierock: "Indie Rock",
  indiepop: "Indie Pop",
  hardrock: "Hard Rock",
  heavymetal: "Heavy Metal",
  numetal: "Nu Metal",
  punkrock: "Punk Rock",
  poppunk: "Pop Punk",
  rocknroll: "Rock & Roll",
  rockandroll: "Rock & Roll",
  "rock&roll": "Rock & Roll",
  rock: "Rock",
  pop: "Pop",
  soul: "Soul",
  funk: "Funk",
  jazz: "Jazz",
  blues: "Blues",
  metal: "Metal",
  punk: "Punk",
  reggae: "Reggae",
  reggaeton: "Reggaeton",
  trap: "Trap",
  house: "House",
  techno: "Techno",
  trance: "Trance",
  dubstep: "Dubstep",
  ambient: "Ambient",
  classical: "Classical",
  country: "Country",
  folk: "Folk",
  soundtrack: "Soundtrack",
  singersongwriter: "Singer-Songwriter",
  cantautorato: "Cantautorato",
  italianpop: "Italian Pop",
  popitaliano: "Pop italiano",
  rapitaliano: "Rap italiano",
  hiphopitaliano: "Hip Hop italiano",
  worldwide: "Worldwide",
};

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Label to show for a genre token, like the hub: a known spelling, else the
 * token with spacing squashed; an all-lower-case token gets Title Case
 * ("pop rap" → "Pop Rap"). Empty for empty input.
 */
export function canonicalGenreLabel(raw: string | null | undefined): string {
  const token = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!token) return "";
  const known = KNOWN_LABELS[normalizeGenreKey(token)];
  if (known) return known;
  return token === token.toLowerCase() ? titleCase(token) : token;
}

/**
 * Tokens of one `genre` field, in order, without duplicates (by
 * `normalizeGenreKey`, first spelling kept) and without numeric junk.
 * Accepts `"; "` (canonical), `/`, `,` and `|` as separators.
 */
export function parseTrackGenres(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of s.split(SPLIT_RE)) {
    const token = part.trim().replace(/\s+/g, " ");
    if (token.length < 2 || NUMERIC_ONLY_RE.test(token)) continue;
    if (STUB_GENRES.has(token.toLowerCase())) continue;
    const key = normalizeGenreKey(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/** Canonical `"; "`-joined form for saving, or null when nothing is left. */
export function serializeTrackGenres(genres: readonly string[] | null | undefined): string | null {
  if (!genres?.length) return null;
  const s = parseTrackGenres(genres.join("; ")).join("; ");
  return s || null;
}

/** "Rock · Pop" for display; aliases ("R&B; Rhythm & Blues") show once. */
export function formatTrackGenresForDisplay(raw: string | null | undefined): string {
  return genreDraftFromField(raw).map(canonicalGenreLabel).join(" · ");
}

/** Anything with a genre: a track (maybe with the hub's `genres` list) or an album. */
export type GenreSource = {
  genre?: string | null;
  genres?: readonly string[] | null;
};

function rawTokens(src: GenreSource | null | undefined): string[] {
  if (!src) return [];
  if (Array.isArray(src.genres) && src.genres.length) {
    return parseTrackGenres(src.genres.filter((g) => typeof g === "string").join("; "));
  }
  return parseTrackGenres(src.genre);
}

/**
 * Canonical genre labels of a track, falling back to its album's when the
 * track has none. Prefers the hub's `genres` array when it sends one.
 */
export function trackGenres(
  track: GenreSource | null | undefined,
  album?: GenreSource | null,
): string[] {
  // The hub's `genres` are canonical labels already: shown as they are, so
  // they match `GET /library/genres`. A raw `genre` string is canonicalized.
  const fromHub = (src: GenreSource | null | undefined) =>
    Array.isArray(src?.genres) && src!.genres!.length > 0;
  let source: GenreSource | null | undefined = track;
  let tokens = rawTokens(track);
  if (!tokens.length) {
    source = album;
    tokens = rawTokens(album);
  }
  const verbatim = fromHub(source);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const label = verbatim ? token : canonicalGenreLabel(token);
    const key = normalizeGenreKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** Normalized keys of a track's genres (for set operations and matching). */
export function trackGenreKeys(
  track: GenreSource | null | undefined,
  album?: GenreSource | null,
): string[] {
  return trackGenres(track, album).map(normalizeGenreKey);
}

/** First genre of a track (canonical label), or null. */
export function primaryGenre(
  track: GenreSource | null | undefined,
  album?: GenreSource | null,
): string | null {
  return trackGenres(track, album)[0] ?? null;
}

/**
 * Whether any genre of `src` matches the free-text `query` (substring on the
 * normalized key, so "hip hop" finds "Hip-Hop"). Used by search.
 */
export function genresMatchQuery(src: GenreSource | null | undefined, query: string): boolean {
  const q = normalizeGenreKey(query);
  if (!q) return false;
  return rawTokens(src).some((g) => normalizeGenreKey(g).includes(q));
}

/**
 * Identity of a genre *as shown*: the key of its canonical label. Aliases the
 * hub keeps apart ("Rhythm & Blues" and "R&B", "Drum & Bass" and "Drum and
 * Bass") have different `normalizeGenreKey`s but one label, so a picker or a
 * chip row keyed on them would list the same name twice (and a keyed
 * `{#each}` on the label throws `each_key_duplicate`).
 */
export function genreLabelKey(raw: string | null | undefined): string {
  return normalizeGenreKey(canonicalGenreLabel(raw));
}

/** Whether the field holds `genre` or one of its aliases (same label). */
export function fieldHasGenreLabel(raw: string | null | undefined, genre: string): boolean {
  const key = genreLabelKey(genre);
  if (!key) return false;
  return parseTrackGenres(raw).some((g) => genreLabelKey(g) === key);
}

/**
 * Genres of a set of `genre` fields, one entry per label: `count` is how many
 * fields hold it (a field with two aliases counts once). Unsorted.
 */
export function countGenreLabels(
  fields: Iterable<string | null | undefined>,
): Array<{ key: string; label: string; count: number }> {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const raw of fields) {
    const seen = new Set<string>();
    for (const g of parseTrackGenres(raw)) {
      const key = genreLabelKey(g);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = byKey.get(key);
      if (cur) cur.count += 1;
      else byKey.set(key, { key, label: canonicalGenreLabel(g), count: 1 });
    }
  }
  return [...byKey.values()];
}

/**
 * Labels to offer in an "add genre" picker: every genre of `fields`, then the
 * `extra` ones, without `exclude` (label keys already applied) and with each
 * label once. Unsorted.
 */
export function genreLabelChoices(
  fields: Iterable<string | null | undefined>,
  extra: readonly string[],
  exclude: ReadonlySet<string>,
): Array<{ key: string; label: string }> {
  const byKey = new Map<string, string>();
  const add = (g: string) => {
    const key = genreLabelKey(g);
    if (key && !exclude.has(key) && !byKey.has(key)) byKey.set(key, canonicalGenreLabel(g));
  };
  for (const raw of fields) for (const g of parseTrackGenres(raw)) add(g);
  for (const g of extra) add(g);
  return [...byKey.entries()].map(([key, label]) => ({ key, label }));
}

/**
 * Genres of a field as an edit draft: its tokens with one entry per label
 * (`genreLabelKey`), first spelling kept. "R&B; Rhythm & Blues" is one chip,
 * so a chip row keyed on `genreLabelKey` never sees a duplicate key.
 */
export function genreDraftFromField(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of parseTrackGenres(raw)) {
    const key = genreLabelKey(g);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/**
 * `draft` plus the genres typed in `input` (a single genre or a list with any
 * separator), skipping junk tokens and genres already there under any alias.
 * Returns the same array when nothing would be added.
 */
export function addGenresToDraft(draft: readonly string[], input: string): readonly string[] {
  const seen = new Set(draft.map(genreLabelKey));
  const added: string[] = [];
  for (const g of parseTrackGenres(input)) {
    const key = genreLabelKey(g);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(g);
  }
  return added.length ? [...draft, ...added] : draft;
}
