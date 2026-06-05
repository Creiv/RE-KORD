import { LANES } from "../config/gameConfig";
import type { ChartNote } from "../types";

type LaneFlashEntry = { kind: "hit" | "miss"; until: number } | null;

export type LanePadDomState = {
  pressedLanes: boolean[];
  laneFlash: LaneFlashEntry[];
  activeHolds: ChartNote[];
};

function noteEndLane(note: ChartNote): number {
  return note.endLane ?? note.lane;
}

function isHoldingLane(state: LanePadDomState, lane: number): boolean {
  return state.activeHolds.some(
    (n) =>
      n.holding &&
      !n.completed &&
      (n.lane === lane || noteEndLane(n) === lane),
  );
}

/** Aggiorna classi pad/striscia senza re-render React. */
export function applyLanePadDom(
  state: LanePadDomState,
  pads: Array<HTMLButtonElement | null>,
  strips: Array<HTMLDivElement | null>,
): void {
  const now = performance.now();
  for (let i = 0; i < LANES.length; i += 1) {
    const holding = isHoldingLane(state, i);
    const flash = state.laneFlash[i];
    const flashKind =
      flash && flash.until > now ? flash.kind : null;
    const pressed = state.pressedLanes[i] || holding;

    const pad = pads[i];
    if (pad) {
      pad.classList.toggle("is-pressed", pressed);
      pad.classList.toggle("lane-pad--holding", holding);
      pad.classList.toggle("lane-pad--hit", flashKind === "hit");
      pad.classList.toggle("lane-pad--miss", flashKind === "miss");
    }

    const strip = strips[i];
    if (strip) {
      strip.classList.toggle("rhythm-lane-strip__cell--hit", flashKind === "hit");
      strip.classList.toggle("rhythm-lane-strip__cell--miss", flashKind === "miss");
    }
  }
}

export function clearLanePadDom(
  pads: Array<HTMLButtonElement | null>,
  strips: Array<HTMLDivElement | null>,
): void {
  for (let i = 0; i < LANES.length; i += 1) {
    const pad = pads[i];
    if (pad) {
      pad.classList.remove(
        "is-pressed",
        "lane-pad--holding",
        "lane-pad--hit",
        "lane-pad--miss",
      );
    }
    const strip = strips[i];
    if (strip) {
      strip.classList.remove(
        "rhythm-lane-strip__cell--hit",
        "rhythm-lane-strip__cell--miss",
      );
    }
  }
}
