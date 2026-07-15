import type { TrackMeta } from "../types";
import { parseLrcLyrics } from "./lrc";

export type TrackLyricsDotStatus =
  | "busy"
  | "idle"
  | "okLrc"
  | "okPlain"
  | "missing"
  | "error";

export type TrackLyricsEphemeralAutoStatus =
  | "idle"
  | "okLrc"
  | "okPlain"
  | "missing"
  | "error";

/** Pallino stato Auto LRC — stessa logica in Studio Ascolta e dialog modifica brano. */
export function resolveTrackLyricsDotStatus(opts: {
  meta?: TrackMeta | null;
  lyricsText?: string;
  fetchBusy?: boolean;
  ephemeralAutoStatus?: TrackLyricsEphemeralAutoStatus;
}): TrackLyricsDotStatus {
  if (opts.fetchBusy) return "busy";

  const lyrics = String(opts.lyricsText ?? opts.meta?.lyrics ?? "").trim();
  const ephemeral = opts.ephemeralAutoStatus ?? "idle";

  if (lyrics) {
    return parseLrcLyrics(lyrics).length > 0 ? "okLrc" : "okPlain";
  }
  if (ephemeral === "error") return "error";
  if (ephemeral === "missing" || opts.meta?.lyricsAutoChecked) return "missing";
  return "idle";
}
