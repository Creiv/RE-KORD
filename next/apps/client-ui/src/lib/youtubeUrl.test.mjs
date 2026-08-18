/**
 * Smoke test for URL classification (node --experimental-strip-types not required:
 * duplicates key assertions from youtubeUrl.ts for CI-less local check).
 */
import assert from "node:assert/strict";

function tryParseYoutubeUrl(raw) {
  try {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    return new URL(s.startsWith("//") ? `https:${s}` : s);
  } catch {
    return null;
  }
}

function isYoutubeDlHost(u) {
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  return (
    h === "youtu.be" ||
    h === "m.youtube.com" ||
    h.endsWith("music.youtube.com") ||
    h.endsWith("youtube.com")
  );
}

function urlMatchesVideoSingle(raw) {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  if (u.href.toLowerCase().includes("start_radio")) return false;
  const list = u.searchParams.get("list");
  if (list != null && String(list).trim() !== "") return false;
  const p = u.pathname.toLowerCase();
  if (p.includes("/playlist") || p.includes("/releases") || p.includes("/browse"))
    return false;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  if (h === "youtu.be") return u.pathname.replace(/^\//, "").length >= 8;
  if (p === "/watch" || p.startsWith("/watch/")) return true;
  if (p.startsWith("/shorts/") || p.startsWith("/live/")) return true;
  return false;
}

function urlMatchesVideoPlaylist(raw) {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  const list = u.searchParams.get("list");
  if (list != null && String(list).trim() !== "") return true;
  return u.pathname.toLowerCase().includes("/playlist");
}

function urlMatchesVideoReleases(raw) {
  const u = tryParseYoutubeUrl(raw);
  if (!u || !isYoutubeDlHost(u)) return false;
  return u.pathname.toLowerCase().includes("releases");
}

function urlMatchesYtMusicBrowse(raw) {
  const u = tryParseYoutubeUrl(raw);
  if (!u) return false;
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  if (!h.endsWith("music.youtube.com")) return false;
  const p = u.pathname.toLowerCase();
  return p.includes("/browse") || p.includes("/channel/");
}

function detectStudioDlMode(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (urlMatchesVideoReleases(t) || urlMatchesYtMusicBrowse(t)) return "releases";
  if (urlMatchesVideoPlaylist(t)) return "playlist";
  if (urlMatchesVideoSingle(t)) return "single";
  return null;
}

const skrillex =
  "https://music.youtube.com/browse/MPADUCibXKvuw5PoJVmyZJ4qhDIw";
assert.equal(detectStudioDlMode(skrillex), "releases");
assert.equal(urlMatchesYtMusicBrowse(skrillex), true);
assert.equal(urlMatchesVideoSingle(skrillex), false);
assert.equal(urlMatchesVideoPlaylist(skrillex), false);

assert.equal(
  detectStudioDlMode("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  "single",
);
assert.equal(
  detectStudioDlMode("https://music.youtube.com/playlist?list=OLAK5uy_abc"),
  "playlist",
);
assert.equal(
  detectStudioDlMode(
    "https://www.youtube.com/channel/UCibXKvuw5PoJVmyZJ4qhDIw/releases",
  ),
  "releases",
);

console.log("youtubeUrl.test.mjs OK");
