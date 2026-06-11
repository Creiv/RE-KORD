export type KaraokeLyricLine = { atSec: number; text: string };

export type KaraokeLines = {
  current: string;
  previous: string;
  next: string;
};

export function parseLrcLyrics(raw: string): KaraokeLyricLine[] {
  const out: KaraokeLyricLine[] = [];
  const rows = raw.split(/\r?\n/);
  for (const row of rows) {
    const text = row.replace(/\[[^\]]*]/g, "").trim();
    const tags = [...row.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    for (const m of tags) {
      const mm = Number(m[1] || 0);
      const ss = Number(m[2] || 0);
      const fracRaw = String(m[3] || "");
      const frac =
        fracRaw.length === 0
          ? 0
          : fracRaw.length === 1
            ? Number(fracRaw) / 10
            : fracRaw.length === 2
              ? Number(fracRaw) / 100
              : Number(fracRaw) / 1000;
      const atSec = mm * 60 + ss + frac;
      if (Number.isFinite(atSec)) out.push({ atSec, text });
    }
  }
  out.sort((a, b) => a.atSec - b.atSec);
  return out;
}

function plainLyricsLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*]/g, "").trim())
    .filter(Boolean);
}

export function resolveKaraokeLines(
  lyricsRaw: string,
  progressTime: number,
  duration: number,
  fallbackTitle: string,
): KaraokeLines {
  const parsedLrc = parseLrcLyrics(lyricsRaw);
  let currentLrcIdx = -1;
  for (let i = 0; i < parsedLrc.length; i += 1) {
    if (progressTime >= parsedLrc[i]!.atSec) currentLrcIdx = i;
    else break;
  }
  const lines = plainLyricsLines(lyricsRaw);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 180;
  const progress = Math.min(0.999, Math.max(0, progressTime / safeDuration));
  const plainIdx = lines.length
    ? Math.min(lines.length - 1, Math.floor(progress * lines.length))
    : -1;

  const hasLrc = parsedLrc.length > 0;
  const current = hasLrc
    ? currentLrcIdx >= 0
      ? parsedLrc[currentLrcIdx]?.text?.trim() || ""
      : ""
    : plainIdx >= 0
      ? lines[plainIdx] || ""
      : fallbackTitle;
  const previous = hasLrc
    ? currentLrcIdx > 0
      ? parsedLrc[currentLrcIdx - 1]?.text?.trim() || ""
      : ""
    : plainIdx > 0
      ? lines[plainIdx - 1] || ""
      : "";
  const next = hasLrc
    ? currentLrcIdx >= 0
      ? parsedLrc[currentLrcIdx + 1]?.text?.trim() || ""
      : ""
    : plainIdx >= 0
      ? lines[plainIdx + 1] || ""
      : "";

  return { current, previous, next };
}
