/**
 * Helper yt-dlp per lo Studio: argomenti, allowlist domini (anti-SSRF),
 * template output, enrichment releases, parsing log e stato download attivi.
 * Estratto da index.mjs (Fase 6).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { getYoutubeCookiesPathForYtdlp } from "./musicRootConfig.mjs";
import { resolveYtdlpPath } from "./ytdlpPath.mjs";
import { parseYtdlpJsonStdout } from "./catalogWebPreview.mjs";
import { safeRelSeg } from "./pathSafety.mjs";

const execFileAsync = promisify(execFile);

/** downloadId (UUID) → { child, userCancelled, killTimer } per /api/download-cancel */
export const activeYtdlpDownloads = new Map();

export function isUuidDownloadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim()
  );
}

export const STUDIO_DOWNLOAD_KINDS = new Set([
  "download_single",
  "download_playlist",
  "download_releases",
  "download_ytmusic",
]);
/**
 * Solo formati audio già muxati: niente merge, niente postprocessori che richiedono ffmpeg
 * (--add-metadata / -x / estrazione usano ffmpeg e non sono supportati in produzione).
 */
const YTDLP_ARGS = ["-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio"];

export function ytdlpArgsBase() {
  if (process.env.REKORD_YTDLP_LOSSLESS === "1") {
    console.warn(
      "[rekord] REKORD_YTDLP_LOSSLESS is ignored: lossless extraction requires ffmpeg, which RE-KORD does not rely on."
    );
  }
  return YTDLP_ARGS;
}

export function ytdlpJavascriptArgs() {
  const configured = String(process.env.REKORD_YTDLP_JS_RUNTIME || "").trim();
  const runtime = configured || process.execPath;
  const args = runtime
    ? ["--js-runtimes", `node:${runtime}`]
    : ["--js-runtimes", "node"];
  const remote = String(process.env.REKORD_YTDLP_REMOTE_COMPONENTS || "").trim();
  if (remote) args.push("--remote-components", remote);
  return args;
}

export function normalizeHttpUrlForYtdlp(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  if (s.startsWith("//")) return `https:${s}`;
  return s;
}

export function pickFlatPlaylistEntryUrl(e) {
  const from = [e.url, e.webpage_url, e.original_url];
  for (const v of from) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/** URL assoluto per yt-dlp (path relativi da --flat-playlist, link //, ecc.). */
export function coerceYtdlpUrl(raw) {
  let s = normalizeHttpUrlForYtdlp(raw);
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `https://www.youtube.com${s}`;
  if (/^(?:watch\?|playlist\?|embed\/|shorts\/)/i.test(s)) {
    return `https://www.youtube.com/${s}`;
  }
  return s;
}

/**
 * Allowlist domini per i download yt-dlp: solo sorgenti musicali note.
 * Evita che il server esegua yt-dlp verso URL arbitrari o indirizzi
 * interni della rete (SSRF).
 */
const YTDLP_ALLOWED_HOSTS = new Set([
  "youtube.com",
  "music.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "soundcloud.com",
  "bandcamp.com",
]);

export function isAllowedYtdlpDownloadUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return false;
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (YTDLP_ALLOWED_HOSTS.has(h)) return true;
    // Sottodomini (es. artista.bandcamp.com, on.soundcloud.com)
    for (const allowed of YTDLP_ALLOWED_HOSTS) {
      if (h.endsWith(`.${allowed}`)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Se l'estrattore non espone href completo, ricostruisci da id (playlist / video). */
export function guessYoutubeUrlFromEntryId(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(s)}`;
  }
  if (/^(?:PL|OLAK5uy_|UU|FL|RD|WL|LL|LM)[a-zA-Z0-9_-]+$/.test(s)) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(s)}`;
  }
  return "";
}

export function ytdlpCookieArgs() {
  const cookies = getYoutubeCookiesPathForYtdlp();
  return cookies ? ["--cookies", cookies] : [];
}

export function ytdlpCookiesConfigured() {
  return Boolean(getYoutubeCookiesPathForYtdlp());
}

export function ytdlpCookieArgsForDisplay() {
  return ytdlpCookiesConfigured() ? ["--cookies", "<server-configured>"] : [];
}

export function ytdlpChildExecOptions() {
  return { env: { ...process.env, FORCE_COLOR: "0" }, ...winHideExec() };
}
export function winHideExec() {
  return process.platform === "win32" ? { windowsHide: true } : {};
}

/** Su Windows `child.kill` non ferma spesso l’albero yt-dlp (python/ffmpeg); usa taskkill /T /F. */
export function forceKillStudioYtdlp(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid != null) {
    execFile(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true },
      (err) => {
        if (err && !child.killed) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      }
    );
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}
export function releaseEnrichConfig() {
  const raw = String(
    process.env.REKORD_YTDLP_RELEASE_MAX_COUNT_ENRICH ?? "0"
  ).trim();
  const max =
    raw === "" || raw === "0" ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);
  const defTimeout = process.platform === "win32" ? 32_000 : 18_000;
  const tStr = process.env.REKORD_YTDLP_RELEASE_COUNT_TIMEOUT_MS;
  const t =
    tStr != null && String(tStr).trim() !== ""
      ? String(tStr).trim()
      : String(defTimeout);
  const timeoutMs = Math.min(
    120_000,
    Math.max(2000, Number.parseInt(t, 10) || defTimeout)
  );
  const defConc = process.platform === "win32" ? 3 : 5;
  const cStr = process.env.REKORD_YTDLP_RELEASE_COUNT_CONCURRENCY;
  const c =
    cStr != null && String(cStr).trim() !== ""
      ? String(cStr).trim()
      : String(defConc);
  const concurrency = Math.min(
    16,
    Math.max(1, Number.parseInt(c, 10) || defConc)
  );
  return { max, timeoutMs, concurrency };
}

/** Conteggio brani per URL playlist (un solo yt-dlp -J: timeout per non bloccare mai all’infinito). */
export async function ytdlpPlaylistTrackCount(program, playlistUrl, timeoutMs) {
  const args = [
    "-J",
    "--flat-playlist",
    "--no-download",
    "--no-warnings",
    ...ytdlpJavascriptArgs(),
    ...ytdlpCookieArgs(),
    playlistUrl,
  ];
  try {
    const { stdout } = await execFileAsync(program, args, {
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      ...ytdlpChildExecOptions(),
      timeout: timeoutMs,
    });
    const j = parseYtdlpJsonStdout(stdout);
    if (!j || typeof j !== "object") return null;
    if (j._type === "video") return 1;
    if (typeof j.playlist_count === "number" && j.playlist_count >= 0) {
      return j.playlist_count;
    }
    if (Array.isArray(j.entries)) return j.entries.length;
    return null;
  } catch {
    return null;
  }
}

export async function enrichReleaseEntryChunks(
  program,
  items,
  timeoutMs,
  concurrency
) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const part = await Promise.all(
      chunk.map(async (item) => {
        const trackCount = await ytdlpPlaylistTrackCount(
          program,
          item.url,
          timeoutMs
        );
        return { ...item, trackCount };
      })
    );
    out.push(...part);
  }
  return out;
}

/**
 * Esegue il conteggio brani in parallelo (fino a concurrency) e invoca onEntry
 * nell’ordine originale (0, 1, 2, …) non appena ogni slot è pronto.
 * Con max: solo le prime voci hanno ytdlp; le altre hanno trackCount: null.
 */
export async function enrichReleaseEntriesInOrder(
  program,
  items,
  max,
  timeoutMs,
  concurrency,
  onEntry
) {
  const n = items.length;
  if (n === 0) return;
  const out = new Array(n);
  let nextEmit = 0;
  const tryEmit = () => {
    while (nextEmit < n && out[nextEmit] != null) {
      onEntry(out[nextEmit]);
      nextEmit += 1;
    }
  };
  let nextI = 0;
  async function worker() {
    while (true) {
      const i = nextI;
      nextI += 1;
      if (i >= n) return;
      const item = items[i];
      let trackCount = null;
      if (max === 0 || i < max) {
        trackCount = await ytdlpPlaylistTrackCount(
          program,
          item.url,
          timeoutMs
        );
      }
      out[i] = { ...item, trackCount };
      tryEmit();
    }
  }
  const k = Math.min(concurrency, n);
  await Promise.all(Array.from({ length: k }, () => worker()));
}

export async function enrichReleaseEntriesWithTrackCounts(program, items) {
  const { max, timeoutMs, concurrency } = releaseEnrichConfig();
  if (max > 0 && items.length > max) {
    const head = await enrichReleaseEntryChunks(
      program,
      items.slice(0, max),
      timeoutMs,
      concurrency
    );
    const tail = items
      .slice(max)
      .map((item) => ({ ...item, trackCount: null }));
    return [...head, ...tail];
  }
  return enrichReleaseEntryChunks(program, items, timeoutMs, concurrency);
}

export function buildYoutubeReleasesListEntries(data) {
  const raw = Array.isArray(data.entries) ? data.entries : [];
  const entries = [];
  for (const e of raw) {
    const id = String(e.id ?? "").trim();
    const title = String(e.title ?? "").trim();
    let norm = coerceYtdlpUrl(pickFlatPlaylistEntryUrl(e));
    if (!norm || !/^https?:\/\//i.test(norm)) {
      norm = guessYoutubeUrlFromEntryId(id);
    }
    if (id && title && norm && /^https?:\/\//i.test(norm)) {
      entries.push({ id, title, url: norm });
    }
  }
  return {
    entries,
    listTitle: String(data.title ?? "").trim(),
    uploader: String(
      data.uploader ?? data.channel ?? data.uploader_id ?? ""
    ).trim(),
    channelUrl: String(data.channel_url ?? data.uploader_url ?? "").trim(),
  };
}

export function writeYoutubeReleasesNdjsonLine(res, obj) {
  if (res.writableEnded) return;
  res.write(`${JSON.stringify(obj)}\n`);
}

export function isProbablyPlaylistUrl(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get("list");
    if (list && list !== "" && list.toUpperCase() !== "WL") return true;
    if (/\/playlist(\/|$|\?)/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export const YTDLP_NAME = "%(track,title)s";

/** playlist_index per URL da playlist; altrimenti NA su singolo video. */
export function ytdlpTrackIndexFragment(url) {
  return isProbablyPlaylistUrl(url)
    ? "%(playlist_index)02d"
    : "%(autonumber)02d";
}

export function relPathLooksLikeAlbumFolder(relPath) {
  return String(relPath || "")
    .split("/")
    .filter(Boolean).length >= 2;
}

export function flatTracksDestKinds(downloadKind) {
  return (
    downloadKind === "download_single" ||
    downloadKind === "download_playlist" ||
    downloadKind === "download_ytmusic" ||
    downloadKind === "download_releases"
  );
}

export function ytdlpOutputTemplate(url, downloadKind = "download_unknown", outputDir = "") {
  if (
    flatTracksDestKinds(downloadKind) &&
    relPathLooksLikeAlbumFolder(outputDir)
  ) {
    return `${ytdlpTrackIndexFragment(url)} - ${YTDLP_NAME}.%(ext)s`;
  }
  const n = ytdlpTrackIndexFragment(url);
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.endsWith("bandcamp.com")) {
      return `%(album)s/${n} - ${YTDLP_NAME}.%(ext)s`;
    }
    const pl = isProbablyPlaylistUrl(url);
    if (host.includes("music.youtube.com")) {
      if (pl) {
        return `%(album|playlist_title)s/${n} - ${YTDLP_NAME}.%(ext)s`;
      }
      return `%(album)s/${n} - ${YTDLP_NAME}.%(ext)s`;
    }
    if (pl) {
      return `%(playlist_title)s/${n} - ${YTDLP_NAME}.%(ext)s`;
    }
  } catch {
    /* ignore */
  }
  return `%(title)s/${n} - ${YTDLP_NAME}.%(ext)s`;
}

/** Argomenti yt-dlp allineati a POST /api/download (senza URL finale). */
export function buildStudioDownloadYtdlpArgs(url, downloadKind, outputDirForLog) {
  const outputDir = safeRelSeg(String(outputDirForLog ?? ""));
  const outTmpl = ytdlpOutputTemplate(url, downloadKind, outputDir ?? "");
  const args = [
    ...ytdlpArgsBase(),
    ...ytdlpJavascriptArgs(),
    ...ytdlpCookieArgs(),
    "-o",
    outTmpl,
  ];
  if (outputDir != null && outputDir.length > 0) {
    const oi = args.findIndex((arg) => arg === "-o" || arg === "--output");
    if (oi >= 0 && args[oi + 1] != null) {
      const prefix = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
      args[oi + 1] = `${prefix}/${String(args[oi + 1]).replace(/^\//, "")}`;
    }
  }
  if (downloadKind === "download_single") args.push("--no-playlist");
  return args;
}

export function ytdlpItemSummaryFromLog(stdout, stderr) {
  const raw = `${stderr || ""}\n${stdout || ""}`;
  const downloaded = [];
  const skippedItems = [];
  const failedItems = [];
  const seenDownloaded = new Set();
  const seenSkipped = new Set();
  const seenFailed = new Set();
  const addDownloaded = (label) => {
    const s = String(label || "").trim();
    if (!s || seenDownloaded.has(s)) return;
    seenDownloaded.add(s);
    downloaded.push(s);
  };
  const addSkipped = (label, reason) => {
    const s = String(label || "").trim();
    if (!s) return;
    const key = `${s}\0${reason}`;
    if (seenSkipped.has(key)) return;
    seenSkipped.add(key);
    skippedItems.push({ label: s, reason });
  };
  const addFailed = (label, reason) => {
    const s = String(label || "").trim();
    const r = String(reason || "download failed").trim() || "download failed";
    const key = `${s}\0${r}`;
    if (seenFailed.has(key)) return;
    seenFailed.add(key);
    failedItems.push({ label: s || "unknown item", reason: r });
  };
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    let m = line.match(/\[download\]\s+Destination:\s+(.+)$/i);
    if (m) {
      addDownloaded(m[1]);
      continue;
    }
    m = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);
    if (m) {
      addSkipped(m[1], "already downloaded");
      continue;
    }
    if (/\[download\].*(Already downloaded|has already been recorded)/i.test(line)) {
      addSkipped(line.replace(/^\[download\]\s*/i, ""), "already downloaded");
      continue;
    }
    if (/^(ERROR|WARNING):/i.test(line) || /\b(age|sign in|private|unavailable|blocked|members-only|geoblock)\b/i.test(line)) {
      addFailed(line.replace(/^(ERROR|WARNING):\s*/i, ""), line);
    }
  }
  return { downloadedItems: downloaded, skippedItems, failedItems };
}

export function ytdlpCmdDisplay() {
  const bin = resolveYtdlpPath();
  const base = ytdlpArgsBase();
  const js = ytdlpJavascriptArgs();
  const cook = ytdlpCookieArgsForDisplay();
  const note = " (m4a → webm/opus → bestaudio; no ffmpeg / no metadata embed)";
  return `${bin} ${[
    ...base,
    ...js,
    ...cook,
    "-o",
    `%(folder)s/%(autonumber)02d - ${YTDLP_NAME}.%(ext)s`,
  ]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ")} + URL${note} — folder = …, nome file = track|title`;
}
export function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

export function extractLastItemProgress(text) {
  const clean = stripAnsi(String(text));
  const rows = [...clean.matchAll(/Downloading item\s+(\d+)\s+of\s+(\d+)/gi)];
  const last = rows.length ? rows[rows.length - 1] : null;
  return last ? { current: Number(last[1]), total: Number(last[2]) } : null;
}

export const YTDLP_ROLL_LOG_CAP_CHARS = 64 * 1024;
const YTDLP_DONE_FIELD_MAX_CHARS = 12 * 1024;

export function appendRollingCapped(acc, chunk, maxChars) {
  acc.totalChars += chunk.length;
  const next = acc.buffer + chunk;
  acc.buffer = next.length <= maxChars ? next : next.slice(-maxChars);
}

export function trimLogForNdjson(acc) {
  const s = acc.buffer;
  const total = acc.totalChars;
  const truncated = total > YTDLP_DONE_FIELD_MAX_CHARS;
  if (s.length <= YTDLP_DONE_FIELD_MAX_CHARS)
    return { text: s, truncated, totalChars: total };
  const headLen = Math.floor(YTDLP_DONE_FIELD_MAX_CHARS / 2 - 48);
  const tailLen = Math.floor(YTDLP_DONE_FIELD_MAX_CHARS / 2 - 48);
  return {
    text: `${s.slice(
      0,
      Math.max(headLen, 0)
    )}\n… [truncated stdout/stderr preview] …\n${s.slice(
      -Math.max(tailLen, 0)
    )}`,
    truncated: true,
    totalChars: total,
  };
}
