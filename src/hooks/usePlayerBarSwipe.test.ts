import { describe, expect, it } from "vitest";
import { isPlayerBarSwipeIgnoredTarget } from "./usePlayerBarSwipe";

describe("isPlayerBarSwipeIgnoredTarget", () => {
  it("ignora play/pausa e menu mobile", () => {
    document.body.innerHTML = `
      <div class="player-bar2__row">
        <div class="player-bar2__identity">
          <button type="button" class="player-bar2__crumb" id="crumb">Artist</button>
        </div>
        <div class="player-bar2__transport player-bar2__transport--mobile">
          <div class="player-bar2__mobile-menu-wrap"><button type="button" id="menu">…</button></div>
          <button type="button" class="player-bar2__ic player-bar2__ic--play" id="play">Play</button>
        </div>
      </div>
    `;
    expect(isPlayerBarSwipeIgnoredTarget(document.getElementById("crumb"))).toBe(false);
    expect(isPlayerBarSwipeIgnoredTarget(document.getElementById("play"))).toBe(true);
    expect(isPlayerBarSwipeIgnoredTarget(document.getElementById("menu"))).toBe(true);
  });

  it("consente swipe su titolo e copertina", () => {
    document.body.innerHTML = `
      <div class="player-bar2__identity">
        <div class="player-bar2__art-hit" id="art"></div>
        <strong id="title">Track</strong>
      </div>
    `;
    expect(isPlayerBarSwipeIgnoredTarget(document.getElementById("art"))).toBe(false);
    expect(isPlayerBarSwipeIgnoredTarget(document.getElementById("title"))).toBe(false);
  });
});
