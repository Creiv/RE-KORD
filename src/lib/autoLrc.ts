import { fetchTrackLyrics, saveTrackInfoManual } from "./api";
import type { EnrichedTrack, LibraryEntityDelta } from "../types";

export type AutoLrcStatus = "okLrc" | "okPlain" | "missing";

export type AutoLrcResult = {
  status: AutoLrcStatus;
  lyrics: string | null;
  delta: LibraryEntityDelta;
};

function buildTrackDelta(
  saved: Awaited<ReturnType<typeof saveTrackInfoManual>>,
  track: EnrichedTrack,
  metaOverrides: Partial<NonNullable<EnrichedTrack["meta"]>>
): LibraryEntityDelta {
  return {
    relPath: saved.relPath,
    track:
      saved.track ??
      ({
        relPath: saved.relPath,
        title: track.title,
        meta: {
          ...(track.meta || {}),
          ...(saved.meta as EnrichedTrack["meta"]),
          ...metaOverrides,
        } as EnrichedTrack["meta"],
      } satisfies LibraryEntityDelta["track"]),
    album: saved.album,
  };
}

/**
 * Auto LRC "quick save": cerca il testo (sincronizzato o plain) e lo salva
 * subito sul brano. Se non trova nulla marca `lyricsAutoChecked` così la UI
 * può distinguere "mai cercato" da "cercato senza risultato".
 */
export async function runAutoLrcQuickSaveForTrack(
  track: EnrichedTrack
): Promise<AutoLrcResult> {
  const fetched = await fetchTrackLyrics(track.relPath);
  const synced = String(fetched.syncedLyrics || "").trim();
  const plain = String(fetched.plainLyrics || "").trim();
  const next = synced || plain;
  if (!next) {
    const saved = await saveTrackInfoManual(track.relPath, {
      lyricsAutoChecked: true,
    });
    return {
      status: "missing",
      lyrics: null,
      delta: buildTrackDelta(saved, track, {
        lyrics: null,
        lyricsAutoChecked: true,
      }),
    };
  }
  const saved = await saveTrackInfoManual(track.relPath, { lyrics: next });
  return {
    status: synced ? "okLrc" : "okPlain",
    lyrics: next,
    delta: buildTrackDelta(saved, track, { lyrics: next }),
  };
}

/** Dopo un errore Auto LRC prova comunque a marcare il brano come verificato. */
export async function markAutoLrcCheckedAfterError(
  track: EnrichedTrack
): Promise<LibraryEntityDelta | null> {
  try {
    const saved = await saveTrackInfoManual(track.relPath, {
      lyricsAutoChecked: true,
    });
    return buildTrackDelta(saved, track, { lyricsAutoChecked: true });
  } catch {
    return null;
  }
}
