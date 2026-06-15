import { useCallback, useRef } from "react";

const SWIPE_THRESHOLD_PX = 48;
const SWIPE_MAX_VERTICAL_PX = 40;
const SWIPE_ACTIVATE_PX = 12;
const TAP_MAX_MOVE_PX = 10;

/** Solo play/pausa e menu overflow: il resto della riga (anche artista/album) è swipeabile. */
export const PLAYER_BAR_SWIPE_IGNORE_SELECTOR =
  ".player-bar2__transport--mobile, .progress2, input";

export function isPlayerBarSwipeIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return Boolean(target.closest(PLAYER_BAR_SWIPE_IGNORE_SELECTOR));
}

type SwipeHandlers = {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
};

export function usePlayerBarSwipe(
  onPrev: () => void,
  onNext: () => void,
  enabled: boolean,
  onTap?: () => void,
): SwipeHandlers {
  const startRef = useRef<{
    x: number;
    y: number;
    id: number;
    capturing: boolean;
  } | null>(null);
  const swipeFiredRef = useRef(false);
  const suppressClickRef = useRef(false);

  const clearStart = useCallback(() => {
    startRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      if (isPlayerBarSwipeIgnoredTarget(event.target)) return;
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        capturing: false,
      };
      swipeFiredRef.current = false;
      suppressClickRef.current = false;
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId || swipeFiredRef.current) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX) {
        clearStart();
        return;
      }
      if (
        !start.capturing &&
        Math.abs(dx) >= SWIPE_ACTIVATE_PX &&
        Math.abs(dx) > Math.abs(dy)
      ) {
        start.capturing = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (!start.capturing) return;
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
      swipeFiredRef.current = true;
      suppressClickRef.current = true;
      if (dx > 0) onPrev();
      else onNext();
      clearStart();
    },
    [clearStart, onNext, onPrev],
  );

  const releaseCapture = useCallback(
    (event: React.PointerEvent, start: NonNullable<typeof startRef.current>) => {
      if (!start.capturing) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* ok */
      }
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId) return;
      if (!swipeFiredRef.current && onTap) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const target = event.target as HTMLElement;
        if (
          Math.abs(dx) <= TAP_MAX_MOVE_PX &&
          Math.abs(dy) <= TAP_MAX_MOVE_PX &&
          !target.closest(".player-bar2__crumb")
        ) {
          onTap();
        }
      }
      releaseCapture(event, start);
      swipeFiredRef.current = false;
      clearStart();
    },
    [clearStart, onTap, releaseCapture],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId) return;
      releaseCapture(event, start);
      swipeFiredRef.current = false;
      suppressClickRef.current = false;
      clearStart();
    },
    [clearStart, releaseCapture],
  );

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  };
}
