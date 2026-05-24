import { useCallback, useRef } from "react";

const SWIPE_THRESHOLD_PX = 48;
const SWIPE_MAX_VERTICAL_PX = 40;
const SWIPE_ACTIVATE_PX = 12;
const TAP_MAX_MOVE_PX = 10;

type SwipeHandlers = {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
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
  const firedRef = useRef(false);

  const reset = useCallback(() => {
    startRef.current = null;
    firedRef.current = false;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled) return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "button, input, .progress2, .player-bar2__crumb, .player-bar2__mobile-menu-wrap",
        )
      ) {
        return;
      }
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        capturing: false,
      };
      firedRef.current = false;
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId || firedRef.current) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX) {
        reset();
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
      firedRef.current = true;
      if (dx > 0) onPrev();
      else onNext();
      reset();
    },
    [onNext, onPrev, reset],
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
      if (!firedRef.current && onTap) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (
          Math.abs(dx) <= TAP_MAX_MOVE_PX &&
          Math.abs(dy) <= TAP_MAX_MOVE_PX
        ) {
          onTap();
        }
      }
      releaseCapture(event, start);
      reset();
    },
    [onTap, releaseCapture, reset],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId) return;
      releaseCapture(event, start);
      reset();
    },
    [releaseCapture, reset],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
