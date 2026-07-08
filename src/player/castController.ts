import type { RefObject } from "react";
import {
  buildCastTrackPayload,
  resolvePlaybackBaseOrigin,
} from "../lib/castMedia";
import {
  canUseWebCastSender,
  registerCastPlaybackCallbacks,
  bootstrapWebCastPlayback,
} from "../lib/castPlayback";
import { readPlayerProgressTime } from "../context/playerProgressStore";
import type { EnrichedTrack } from "../types";
import type { AppConfigSnapshot } from "./types";

export function applyMediaMute(
  muted: boolean,
  mediaMutedRef: RefObject<boolean>,
  audioDeck0: HTMLAudioElement | null,
  audioDeck1: HTMLAudioElement | null,
  onMutedChange: () => void,
): void {
  mediaMutedRef.current = muted;
  if (audioDeck0) audioDeck0.muted = muted;
  if (audioDeck1) audioDeck1.muted = muted;
  onMutedChange();
}

export type CastControllerDeps = {
  currentRef: RefObject<EnrichedTrack | null>;
  appConfigRef: RefObject<AppConfigSnapshot>;
  transcodeAvailableRef: RefObject<boolean>;
  applyMediaMute: (muted: boolean) => void;
};

export function setupCastPlayback(deps: CastControllerDeps): (() => void) | void {
  if (!canUseWebCastSender()) return;
  void bootstrapWebCastPlayback();
  return registerCastPlaybackCallbacks({
    onSessionStart: () => deps.applyMediaMute(true),
    onSessionEnd: () => deps.applyMediaMute(false),
    onRequestSync: () => {
      const track = deps.currentRef.current;
      if (!track) return null;
      const base = resolvePlaybackBaseOrigin(deps.appConfigRef.current);
      return buildCastTrackPayload(track, base, readPlayerProgressTime(), {
        forCast: true,
        transcodeAvailable: deps.transcodeAvailableRef.current,
      });
    },
  });
}
