/**
 * Campo `genre` serializzato con `"; "` (indice libreria / metadati traccia).
 * Accetta anche stili legacy: "a/b", "a, b".
 */
export function parseTrackGenres(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    const x = t.trim();
    if (!x) return;
    const k = x.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
  };
  for (const seg of s.split(/;/)) {
    for (const p of seg.split(/(?:\s*\/\s*|\s*,\s*)/)) {
      add(p);
    }
  }
  return out;
}

export function serializeTrackGenres(genres: readonly string[] | null | undefined): string | null {
  if (!genres?.length) return null;
  const s = parseTrackGenres(genres.join("; ")).join("; ");
  return s || null;
}

export function trackHasGenre(
  raw: string | null | undefined,
  genreToken: string,
): boolean {
  const low = genreToken.trim().toLowerCase();
  if (!low) return false;
  return parseTrackGenres(raw).some((g) => g.toLowerCase() === low);
}

export function formatTrackGenresForDisplay(raw: string | null | undefined): string {
  const g = parseTrackGenres(raw);
  return g.length ? g.join(" · ") : "";
}
