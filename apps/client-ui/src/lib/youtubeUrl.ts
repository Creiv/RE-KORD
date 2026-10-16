export type DlVideoMode = "single" | "playlist" | "releases";

function tryParseYoutubeUrl(raw: string): URL | null {
  try {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    return new URL(s.startsWith("//") ? `https:${s}` : s);
  } catch {
    return null;
  }
}

function isYoutubeDlHost(u: URL): boolean {
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  return (
    h === "youtu.be" ||
    h === "m.youtube.com" ||
    h.endsWith("music.youtube.com") ||
    h.endsWith("youtube.com")
  );
}

/** Single video: no playlist/list, no radio, no release/browse. */
export function urlMatchesVideoSingle(raw: string): boolean {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  const href = u.href.toLowerCase();
  if (href.includes("start_radio")) return false;
  const list = u.searchParams.get("list");
  if (list != null && String(list).trim() !== "") return false;
  const p = u.pathname.toLowerCase();
  if (p.includes("/playlist")) return false;
  if (p.includes("/releases")) return false;
  if (p.includes("/browse")) return false;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  if (h === "youtu.be") {
    return u.pathname.replace(/^\//, "").length >= 8;
  }
  if (p === "/watch" || p.startsWith("/watch/")) return true;
  if (p.startsWith("/shorts/")) return true;
  if (p.startsWith("/live/")) return true;
  if (h.endsWith("music.youtube.com") && (p === "/watch" || p.startsWith("/watch/")))
    return true;
  return false;
}

/** Playlist: list= param set or /playlist path. */
export function urlMatchesVideoPlaylist(raw: string): boolean {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  const list = u.searchParams.get("list");
  if (list != null && String(list).trim() !== "") return true;
  const p = u.pathname.toLowerCase();
  return p.includes("/playlist");
}

/** Releases tab (YouTube / YouTube Music): releases segment in the URL. */
export function urlMatchesVideoReleases(raw: string): boolean {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  return u.pathname.toLowerCase().includes("releases");
}

/** Artist album page on YouTube Music: music host + browse/channel only. */
export function urlMatchesYtMusicBrowse(raw: string): boolean {
  const u = tryParseYoutubeUrl(raw);
  if (!u) return false;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  if (!h.endsWith("music.youtube.com")) return false;
  const p = u.pathname.toLowerCase();
  return p.includes("/browse") || p.includes("/channel/");
}

/** Aligned with the type selected in the Studio Download buttons (mutually exclusive). */
export function urlMatchesStudioDlMode(
  raw: string,
  videoMode: DlVideoMode,
): boolean {
  const t = String(raw ?? "").trim();
  if (!t) return false;
  if (videoMode === "releases")
    return urlMatchesVideoReleases(t) || urlMatchesYtMusicBrowse(t);
  if (videoMode === "single") return urlMatchesVideoSingle(t);
  if (videoMode === "playlist") return urlMatchesVideoPlaylist(t);
  return false;
}

/** Infers the Classic mode best suited to the pasted URL. */
export function detectStudioDlMode(raw: string): DlVideoMode | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (urlMatchesVideoReleases(t) || urlMatchesYtMusicBrowse(t)) return "releases";
  if (urlMatchesVideoPlaylist(t)) return "playlist";
  if (urlMatchesVideoSingle(t)) return "single";
  return null;
}

/**
 * Classic mode for a link handed over from Scopri: the link's own kind wins (a
 * single released as a one-track `playlist?list=` link needs "playlist", or
 * the field flags it as incompatible), the caller's guess is the fallback.
 */
export function classicModeForUrl(raw: string, fallback: DlVideoMode): DlVideoMode {
  return detectStudioDlMode(raw) ?? fallback;
}

export function looksLikeSupportedDownloadUrl(raw: string): boolean {
  try {
    const u = new URL(
      String(raw ?? "").trim().startsWith("//")
        ? `https:${String(raw).trim()}`
        : String(raw ?? "").trim(),
    );
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    return (
      h === "youtube.com" ||
      h === "music.youtube.com" ||
      h === "youtu.be" ||
      h === "m.youtube.com" ||
      h.endsWith(".youtube.com") ||
      h === "soundcloud.com" ||
      h.endsWith(".soundcloud.com") ||
      h === "bandcamp.com" ||
      h.endsWith(".bandcamp.com")
    );
  } catch {
    return false;
  }
}
