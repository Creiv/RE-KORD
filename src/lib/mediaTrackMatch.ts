import { mediaUrl } from "./api";
import { trackPlaybackKey } from "./libraryNav";

/** True when the audio element is playing the given library track (not a stale deck). */
export function audioElementMatchesTrack(
  audio: HTMLAudioElement | null | undefined,
  track: { relPath: string; filePath?: string | null },
): boolean {
  if (!audio?.src) return false;
  try {
    const expected = new URL(
      mediaUrl(trackPlaybackKey(track)),
      window.location.origin,
    ).pathname;
    const actual = new URL(audio.src, window.location.origin).pathname;
    return expected === actual;
  } catch {
    return false;
  }
}
