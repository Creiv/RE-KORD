/**
 * yt-dlp output, made readable (port of legacy `src/lib/ytdlpLogFilter.ts`).
 *
 * The raw log is hundreds of progress lines and Python warnings; the user needs
 * the few lines that say why an item failed. Pure functions: no i18n, no DOM,
 * so they run under `node --test`.
 */

function isYtdlpNoiseLine(line: string): boolean {
  if (/Deprecat|UserWarning|pkg_resources|FutureWarning|Pydantic|CryptographyWarning/i.test(line))
    return true;
  if (/^See https:\/\/(github|yt-dlp)/i.test(line)) return true;
  if (/\[download\]\s+\d+(\.\d+)?%/i.test(line)) return true;
  if (/\[download\]\s+Destination:/i.test(line)) return true;
  if (/\[download\]\s+Resuming|Already downloaded|has already been recorded/i.test(line))
    return true;
  if (/\[Merger\]/i.test(line) && /Merging|Deleting original|ffmpeg/i.test(line)) return true;
  if (/^WARNING: \[(youtube:tab|youtube)\]/i.test(line) && /(Extracting|Filtering)/i.test(line)) {
    return true;
  }
  if (/^WARNING: \[.+\]\s*Unsupported URL/i.test(line)) return true;
  return false;
}

function isYtdlpFileOrItemIssueLine(line: string): boolean {
  if (/\[download\]\s*Got error:/i.test(line)) return true;
  if (/\[download\].*Unable to (download|open)/i.test(line)) return true;
  if (/\[download\].*Did not (get any|find)/i.test(line)) return true;
  if (/\[download\].*Fragment .*not found|giving up after \d+/i.test(line)) return true;
  if (/\[ExtractAudio\].*(ERROR|Failed)/i.test(line)) return true;
  if (/\[Postprocessor\].*Error/i.test(line)) return true;
  if (/\[EmbedSubtitle\].*Error/i.test(line)) return true;
  if (/\[VideoConvertor\].*Error/i.test(line)) return true;
  if (/^ERROR:\s*/i.test(line) || /\bERROR: \[/.test(line)) return true;
  if (
    /^WARNING:.*(unavailable|not available|Private video|blocked|age|Sign in|members-only|geoblock)/i.test(
      line,
    )
  )
    return true;
  if (/^WARNING: \[(youtube|vimeo|soundcloud|bandcamp|spotify|generic)\].*ERROR/i.test(line))
    return true;
  if (
    /\bVideo unavailable|Private video|This (video|content) (is|may be) (unavailable|not available|blocked)\b/i.test(
      line,
    )
  )
    return true;
  if (
    /\bHTTP Error (40[34]|41[06]|45[23])\b/.test(line) &&
    (/\[download\]|http/i.test(line) || /fragment/i.test(line))
  )
    return true;
  if (/\bUnable to (download|extract|open)\b.*\b(video|data|file|file fragment)\b/i.test(line))
    return true;
  if (/\bFailed to (download|merge|extract|write|delete)\b/i.test(line)) return true;
  if (/^ERROR: (Unable|Request|The server)/i.test(line)) return true;
  return false;
}

/**
 * The lines worth showing for a failed job (empty for a successful one).
 * Duplicates are folded so twelve identical 403s read as one line.
 */
export function ytdlpLogDetailForUser(r: {
  ok: boolean;
  stderr?: string | null;
  stdout?: string | null;
  error?: string | null;
}): string {
  if (r.ok) return "";
  const raw = [r.error, r.stderr, r.stdout].filter((x) => x != null && x !== "").join("\n");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (isYtdlpNoiseLine(line)) continue;
    if (isYtdlpFileOrItemIssueLine(line) && !seen.has(line)) {
      seen.add(line);
      kept.push(line);
    }
  }
  if (kept.length > 0) return kept.join("\n");
  if (r.error && !isYtdlpNoiseLine(r.error)) {
    return r.error.replace(/\n[\s\S]*/, "");
  }
  for (const line of lines) {
    if (isYtdlpNoiseLine(line)) continue;
    if (/^ERROR:\s*/i.test(line) || /^\[.+\] ERROR:/i.test(line)) return line;
  }
  const last = lines[lines.length - 1];
  if (!last) return "";
  return last.length > 220 ? `${last.slice(0, 217)}…` : last;
}

/** Strip noise from a raw log, keeping the lines a curious user would read. */
export function ytdlpLogWithoutNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !isYtdlpNoiseLine(l.trim()))
    .join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hide absolute filesystem paths: the library root becomes relative, any other
 * absolute directory collapses to "…/" (keeps the file name, drops the host
 * layout). URLs are left alone.
 */
export function redactPaths(text: string, roots: Array<string | null | undefined> = []): string {
  let out = text;
  for (const root of roots) {
    const r = (root ?? "").trim().replace(/[\\/]+$/, "");
    if (r.length < 2) continue;
    out = out.replace(new RegExp(`${escapeRegExp(r)}[\\\\/]?`, "g"), "");
  }
  // Windows drive paths: C:\Users\x\Music\
  out = out.replace(/\b[A-Za-z]:\\(?:[^\s"'\\]+\\)+/g, "…\\");
  // POSIX absolute dirs not part of a URL (no "scheme:" or "/" right before).
  out = out.replace(/(?<![\w:/.~%-])\/(?:[^\s"'/]+\/)+/g, "…/");
  // Home shorthand.
  out = out.replace(/(?<![\w/])~\/(?:[^\s"'/]+\/)+/g, "…/");
  return out;
}

export type DownloadIssue = "no_audio_format" | "http_403" | "ytdlp_missing" | "sign_in" | null;

/** Known whole-job failures, recognised from an error code or from the log. */
export function detectDownloadIssue(code: string | null | undefined, log: string): DownloadIssue {
  const c = (code ?? "").toLowerCase();
  if (c === "no_audio_format") return "no_audio_format";
  if (c === "http_forbidden" || c === "http_403" || c === "preview_upstream_forbidden") return "http_403";
  if (c === "ytdlp_missing" || c === "ytdlp_not_found" || c === "ytdlp_spawn_failed") return "ytdlp_missing";
  if (/Requested format is not available|No video formats found|no audio format/i.test(log)) {
    return "no_audio_format";
  }
  if (/HTTP Error 403/i.test(log)) return "http_403";
  if (isCookieIssueCode(c) || /Sign in to confirm|confirm your age|use --cookies/i.test(log)) return "sign_in";
  return null;
}

/** yt-dlp codes that YouTube cookies (missing or expired) explain. */
export function isCookieIssueCode(code: string | null | undefined): boolean {
  const c = (code ?? "").toLowerCase();
  return c === "sign_in_required" || c === "age_restricted";
}
