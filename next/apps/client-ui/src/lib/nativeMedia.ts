/**
 * Ponte verso la notifica media del guscio Android.
 *
 * La WebView di Android non ha la Media Session API: `navigator.mediaSession`
 * non esiste, quindi nulla di quello che scrive `mediaSession.ts` arriva al
 * sistema. Il guscio espone allora `window.RekordMediaNative`, e da qui gli si
 * racconta lo stesso stato che gli altri client mandano al sistema operativo.
 * L'audio resta nella pagina: di la' si disegna solo la notifica, che rimanda i
 * comandi indietro con l'evento `rekord:media-action`.
 *
 * Fuori da Android il ponte non c'e' e ogni funzione qui non fa niente.
 */

/** Stato che il lato Kotlin sa leggere (`NowPlaying.fromJson`). */
type NativeSnapshot = {
  title: string;
  artist: string;
  album: string;
  artworkUrl: string;
  playing: boolean;
  durationMs: number;
  positionMs: number;
};

type NativeMediaBridge = {
  update: (json: string) => void;
  stop: () => void;
};

/**
 * Metadati, stato e posizione arrivano da tre chiamate separate a ogni cambio di
 * brano: si aspetta un attimo e si attraversa il ponte una volta sola.
 */
const PUSH_DELAY_MS = 80;

function bridge(): NativeMediaBridge | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as { RekordMediaNative?: NativeMediaBridge })
    .RekordMediaNative;
  if (!raw || typeof raw.update !== "function") return null;
  return raw;
}

let snapshot: NativeSnapshot | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
let lastSent = "";

function flush(): void {
  pending = null;
  const target = bridge();
  if (!target) return;
  if (!snapshot) {
    if (lastSent === "") return;
    lastSent = "";
    try {
      target.stop();
    } catch {
      /* Il guscio se ne e' andato: non c'e' niente da recuperare. */
    }
    return;
  }
  const json = JSON.stringify(snapshot);
  if (json === lastSent) return;
  lastSent = json;
  try {
    target.update(json);
  } catch {
    /* */
  }
}

function schedule(): void {
  if (!bridge()) return;
  if (pending != null) return;
  pending = setTimeout(flush, PUSH_DELAY_MS);
}

export function pushNativeMetadata(
  track: { title: string; artist: string; album: string } | null,
  artworkUrl: string,
): void {
  if (!bridge()) return;
  if (!track) {
    snapshot = null;
    schedule();
    return;
  }
  snapshot = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUrl,
    // Metadati nuovi senza uno stato ancora noto: si tiene quello di prima,
    // altrimenti il cambio brano farebbe lampeggiare la notifica su "in pausa".
    playing: snapshot?.playing ?? false,
    durationMs: 0,
    positionMs: 0,
  };
  schedule();
}

export function pushNativePlaybackState(
  state: "none" | "paused" | "playing",
): void {
  if (!bridge()) return;
  if (state === "none") {
    snapshot = null;
    schedule();
    return;
  }
  if (!snapshot) return;
  snapshot = { ...snapshot, playing: state === "playing" };
  schedule();
}

export function pushNativePosition(duration: number, position: number): void {
  if (!bridge()) return;
  if (!snapshot) return;
  const durationMs = Number.isFinite(duration) && duration > 0
    ? Math.round(duration * 1000)
    : 0;
  const positionMs = Number.isFinite(position) && position > 0
    ? Math.round(position * 1000)
    : 0;
  snapshot = {
    ...snapshot,
    durationMs,
    positionMs: durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs,
  };
  schedule();
}
