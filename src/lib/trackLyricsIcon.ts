import type { TrackMeta } from "../types"
import { parseLrcLyrics } from "./lrc"

export type TrackLyricsIconKind = "hidden" | "off" | "plain" | "lrc"

/** Stato icona lyrics sulle card/righe brano. */
export function trackLyricsIconKind(meta?: TrackMeta | null): TrackLyricsIconKind {
  const lyricsRaw = String(meta?.lyrics ?? "").trim()
  if (lyricsRaw) {
    return parseLrcLyrics(lyricsRaw).length > 0 ? "lrc" : "plain"
  }
  if (meta?.lyricsAutoChecked) return "off"
  return "hidden"
}
