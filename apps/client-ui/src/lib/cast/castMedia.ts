/**
 * Cast media decisions (port of legacy `lib/castMedia.ts`): which formats need
 * transcoding for Google Home / Chromecast, receiver-reachable absolute URLs,
 * MIME types and metadata. Pure — unit-tested in `cast.test.mjs`.
 */

import type { Track } from "../api";
import type { CastMediaMetadata } from "./types";
import { externalArtPath, externalMediaPath, isExternalPath } from "../externalItems";

/** Extensions served by /media with the MIME type a Cast receiver expects. */
export const CAST_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
};

/** Formats Google Home / Cast often fail to decode (legacy list, unchanged). */
export const CAST_TRANSCODE_EXTS: ReadonlySet<string> = new Set(["flac", "ogg", "opus", "wav"]);

export type CastTranscodeFormat = "mp3" | "aac";

const TRANSCODE_MIME: Record<CastTranscodeFormat, string> = {
  mp3: "audio/mpeg",
  aac: "audio/aac",
};

export function fileExtension(relPath: string): string {
  const name = relPath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function needsCastTranscode(relPath: string): boolean {
  return CAST_TRANSCODE_EXTS.has(fileExtension(relPath));
}

export function castMimeTypeForRelPath(relPath: string): string {
  return CAST_MIME_BY_EXT[fileExtension(relPath)] ?? "audio/mpeg";
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === "0.0.0.0"
  );
}

/**
 * Base URL a Chromecast / Google Home on the LAN can open. The receiver cannot
 * reach the sender's localhost: when the hub is addressed as loopback, use the
 * hub's LAN URL (remote-access `lanUrl`) or, failing that, the public tunnel.
 * Returns null when nothing reachable is known.
 */
export function resolveCastMediaBaseUrl(opts: {
  /** Where the client talks to the hub: server base URL or page origin. */
  hubOrigin: string;
  lanUrl?: string | null;
  publicUrl?: string | null;
}): string | null {
  const origin = (u: string | null | undefined) => {
    if (!u?.trim()) return null;
    try {
      const url = new URL(u.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  };
  const hub = origin(opts.hubOrigin);
  if (hub && !isLoopbackHostname(new URL(hub).hostname)) return hub;
  const lan = origin(opts.lanUrl);
  if (lan && !isLoopbackHostname(new URL(lan).hostname)) return lan;
  return origin(opts.publicUrl);
}

export function encodeRelPath(relPath: string): string {
  return relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export type CastStreamOptions = {
  /** Hub reports a working transcoder (`/api/v1/health` → `transcode: true`). */
  transcodeAvailable: boolean;
  format?: CastTranscodeFormat;
};

/** Absolute stream URL for the receiver, transcoded when the format needs it. */
export function castStreamUrl(relPath: string, baseOrigin: string, opts: CastStreamOptions): {
  url: string;
  contentType: string;
  transcoded: boolean;
} {
  const base = baseOrigin.replace(/\/+$/, "");
  if (isExternalPath(relPath)) {
    // Podcast episode / live stream: the receiver fetches the hub proxy too.
    return { url: `${base}${externalMediaPath(relPath) ?? ""}`, contentType: "audio/mpeg", transcoded: false };
  }
  const enc = encodeRelPath(relPath);
  if (opts.transcodeAvailable && needsCastTranscode(relPath)) {
    const format = opts.format ?? "mp3";
    return {
      url: `${base}/api/v1/transcode/${enc}?format=${format}`,
      contentType: TRANSCODE_MIME[format],
      transcoded: true,
    };
  }
  return { url: `${base}/media/${enc}`, contentType: castMimeTypeForRelPath(relPath), transcoded: false };
}

export function castCoverUrl(albumId: number | null | undefined, baseOrigin: string): string | null {
  if (albumId == null) return null;
  return `${baseOrigin.replace(/\/+$/, "")}/api/v1/covers/album/${albumId}`;
}

export function castMetadataForTrack(track: Track, baseOrigin: string): CastMediaMetadata {
  if (isExternalPath(track.rel_path)) {
    const art = externalArtPath(track);
    return {
      title: track.title,
      artist: track.artist_name,
      album: track.external?.sourceName ?? track.album_name,
      coverUrl: art ? `${baseOrigin.replace(/\/+$/, "")}${art}` : null,
    };
  }
  return {
    title: track.title,
    artist: track.artist_name,
    album: track.album_name,
    // No receiver request for an album the hub says has no artwork.
    coverUrl:
      track.has_cover === false || track.album_has_cover === false
        ? null
        : castCoverUrl(track.album_id, baseOrigin),
  };
}

export type CastLoadPlan = {
  url: string;
  contentType: string;
  transcoded: boolean;
  metadata: CastMediaMetadata;
};

export function buildCastLoadPlan(track: Track, baseOrigin: string, opts: CastStreamOptions): CastLoadPlan {
  return {
    ...castStreamUrl(track.rel_path, baseOrigin, opts),
    metadata: castMetadataForTrack(track, baseOrigin),
  };
}

function withKeyQuery(url: string, key: string): string {
  const hash = url.indexOf("#");
  const head = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  return `${head}${head.includes("?") ? "&" : "?"}accessKey=${encodeURIComponent(key)}${tail}`;
}

/**
 * The plan with the hub's access key on the stream and cover URLs: the
 * receiver fetches them itself and cannot send headers. `baseOrigin` is the
 * same hub seen from the LAN or the tunnel (its own remote-access answer), so
 * the key stays with the hub it belongs to; URLs on any other origin are left
 * alone.
 */
export function withCastAccessKey(plan: CastLoadPlan, baseOrigin: string, key: string | null): CastLoadPlan {
  if (!key) return plan;
  let origin: string;
  try {
    origin = new URL(baseOrigin).origin;
  } catch {
    return plan;
  }
  const sameHub = (url: string | null) => {
    if (!url) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  const cover = plan.metadata.coverUrl;
  return {
    ...plan,
    url: sameHub(plan.url) ? withKeyQuery(plan.url, key) : plan.url,
    metadata: {
      ...plan.metadata,
      coverUrl: cover && sameHub(cover) ? withKeyQuery(cover, key) : cover,
    },
  };
}

/**
 * Whether the Google Cast Web Sender can run here: Chrome-family browsers
 * (Chrome, Edge, Brave… on desktop and Android) in a secure context. Not in
 * Tauri / Android WebView / Electron (no Cast extension), not on iOS (WebKit).
 */
export function isWebCastSenderEnvironment(env: {
  userAgent: string;
  isSecureContext: boolean;
  isTauri: boolean;
}): boolean {
  if (env.isTauri || !env.isSecureContext) return false;
  const ua = env.userAgent;
  if (/\bwv\)|; wv;|Electron\/|Tauri/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return false;
  return /\b(Chrome|Chromium|CriOS|Edg|EdgA)\//.test(ua) && !/CriOS\//.test(ua);
}
