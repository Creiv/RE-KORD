import { withAccessKeyQuery } from "./accessKey";
import { externalMediaPath, isExternalPath } from "./externalItems";

const STORAGE_KEY = "rekord.serverBaseUrl";

/**
 * In-memory copy of the hub address: every API and media URL is built from
 * it. `undefined` = not read yet; refreshed by `setServerBaseUrl` and by the
 * `storage` event (another tab changed hub).
 */
let cachedBase: string | undefined;

function readStoredBase(): string {
  const fromEnv = (import.meta.env?.VITE_SERVER_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    return (localStorage.getItem(STORAGE_KEY) || "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** Empty string = same origin / vite proxy. Absolute URL for remote server. */
export function getServerBaseUrl(): string {
  if (cachedBase === undefined) cachedBase = readStoredBase();
  return cachedBase;
}

export function setServerBaseUrl(url: string) {
  const cleaned = url.trim().replace(/\/$/, "");
  cachedBase = cleaned;
  try {
    localStorage.setItem(STORAGE_KEY, cleaned);
  } catch {
    /* private mode: kept for this page */
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key == null || event.key === STORAGE_KEY) cachedBase = undefined;
  });
}

/** Hub URL without the access key: for `fetch`, which sends it as a header. */
export function hubUrl(path: string): string {
  const base = getServerBaseUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}

/**
 * Hub URL for things that cannot send headers (`<audio>`, `<img>`, downloads):
 * carries `accessKey=` when this hub has one stored.
 */
export function apiUrl(path: string): string {
  return withAccessKeyQuery(hubUrl(path), getServerBaseUrl());
}

/**
 * Formats the hub indexes but many engines can't decode (WebKitGTK, Android
 * WebView, Chromium: WMA, AIFF, raw ALAC). For those the hub transcodes on the
 * fly; `canPlayType` decides, so an engine that can play them gets the file.
 */
const PROBE_MIME: Record<string, string> = {
  wma: "audio/x-ms-wma",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  alac: "audio/mp4; codecs=alac",
};

/** Tracks that failed as "format not supported": played transcoded from now on. */
const transcodeRelPaths = new Set<string>();
let probeEl: HTMLAudioElement | null = null;

function engineCannotPlay(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  const mime = dot < 0 ? undefined : PROBE_MIME[relPath.slice(dot + 1).toLowerCase()];
  if (!mime || typeof document === "undefined") return false;
  try {
    probeEl ??= document.createElement("audio");
    return probeEl.canPlayType(mime) === "";
  } catch {
    return false;
  }
}

function encodeRelPath(relPath: string): string {
  return relPath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

/** The file as stored on the hub (Range-capable). */
export function directMediaUrl(relPath: string): string {
  return apiUrl(`/media/${encodeRelPath(relPath)}`);
}

/** What the player should load: the file, or a lossless FLAC copy the hub converts once and serves with Range (seekable). */
export function mediaUrl(relPath: string): string {
  if (isExternalPath(relPath)) {
    // Podcast episode / live stream: through the hub proxy (same origin as
    // /media, so Web Audio visualizers hear it).
    const path = externalMediaPath(relPath);
    return path ? apiUrl(path) : "";
  }
  if (transcodeRelPaths.has(relPath) || engineCannotPlay(relPath)) {
    return apiUrl(`/api/v1/transcode/${encodeRelPath(relPath)}?format=flac`);
  }
  return directMediaUrl(relPath);
}

/**
 * The engine refused this file's format: switch it to the transcoded stream.
 * Returns false when it already was (then the failure is real).
 */
export function markNeedsTranscode(relPath: string): boolean {
  if (isExternalPath(relPath)) return false;
  if (transcodeRelPaths.has(relPath) || engineCannotPlay(relPath)) return false;
  transcodeRelPaths.add(relPath);
  return true;
}
