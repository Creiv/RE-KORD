/**
 * Guardie sui path della libreria musicale (traversal, nomi riservati)
 * e sugli host per fetch upstream. Estratto da index.mjs (Fase 6).
 */
import path from "path";
import net from "node:net";
import { getMusicRoot } from "./musicRootConfig.mjs";

export function underRoot(full, musicRoot = getMusicRoot()) {
  const root = path.resolve(musicRoot);
  const resolved = path.resolve(full);
  return resolved === root || resolved.startsWith(root + path.sep);
}

const RESERVED_MUSIC_DIR_NAMES = new Set(["kord", "wpp"]);

export function hasReservedPathSegment(p) {
  for (const seg of String(p || "")
    .replace(/\\/g, "/")
    .split("/")) {
    if (!seg) continue;
    if (RESERVED_MUSIC_DIR_NAMES.has(seg.toLowerCase())) return true;
  }
  return false;
}

export function pathHasParentDirSegment(p) {
  for (const seg of String(p || "")
    .replace(/\\/g, "/")
    .split("/")) {
    if (seg === "..") return true;
  }
  return false;
}

export function safeRelSeg(value) {
  if (value == null) return null;
  const normalized = String(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  for (const seg of normalized.split("/")) {
    if (seg === "..") return null;
    if (RESERVED_MUSIC_DIR_NAMES.has(seg.toLowerCase())) return null;
  }
  return normalized;
}

export function hostnameBlockedForUpstreamImageFetch(hostname) {
  let h = String(hostname || "")
    .toLowerCase()
    .trim();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  let bare = h;
  if (h.startsWith("[")) bare = h.slice(1, -1) || bare;
  if (net.isIP(bare) !== 0) return true;
  return false;
}
export function albumFolderFromRelPath(relPath) {
  const parts = String(relPath || "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join("/");
}
