import { lyricsKind } from "./trackMoods";

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

/** Pallino stato Auto LRC — parity legacy `resolveTrackLyricsDotStatus`. */
export function resolveTrackLyricsDotStatus(opts: {
  lyricsText?: string | null;
  fetchBusy?: boolean;
  ephemeralAutoStatus?: TrackLyricsEphemeralAutoStatus;
}): TrackLyricsDotStatus {
  if (opts.fetchBusy) return "busy";

  const lyrics = String(opts.lyricsText ?? "").trim();
  const ephemeral = opts.ephemeralAutoStatus ?? "idle";

  if (lyrics) {
    return lyricsKind(lyrics) === "lrc" ? "okLrc" : "okPlain";
  }
  if (ephemeral === "error") return "error";
  if (ephemeral === "missing") return "missing";
  return "idle";
}
