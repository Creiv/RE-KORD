import { parseLrcLyrics } from "./lrc";
import type { ParsedLrcLine } from "./lrc";

export type KaraokeLyricLine = ParsedLrcLine;

export type KaraokeLines = {
  current: string;
  previous: string;
  next: string;
};

export { parseLrcLyrics };

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
