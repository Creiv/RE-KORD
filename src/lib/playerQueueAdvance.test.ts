import { describe, expect, it } from "vitest";
import {
  mediaSessionHasNext,
  mediaSessionHasPrevious,
  resolveNextIndex,
  resolvePrevIndex,
} from "./playerQueueAdvance";

describe("playerQueueAdvance", () => {
  describe("resolveNextIndex", () => {
    it("advances within queue", () => {
      expect(resolveNextIndex(10, 3, "off", false)).toBe(4);
    });

    it("returns null at end without repeat or remainder", () => {
      expect(resolveNextIndex(10, 9, "off", false)).toBeNull();
    });

    it("loops to 0 on repeat all without remainder", () => {
      expect(resolveNextIndex(10, 9, "all", false)).toBe(0);
    });

    it("consumes remainder before looping on repeat all", () => {
      expect(resolveNextIndex(50, 49, "all", true)).toBe(50);
    });

    it("stays on current for repeat one", () => {
      expect(resolveNextIndex(10, 5, "one", false)).toBe(5);
    });
  });

  describe("resolvePrevIndex", () => {
    it("goes to previous track", () => {
      expect(resolvePrevIndex(10, 3, "off")).toBe(2);
    });

    it("wraps on repeat all", () => {
      expect(resolvePrevIndex(10, 0, "all")).toBe(9);
    });
  });

  describe("mediaSessionHasNext", () => {
    it("is true with remainder at end of window", () => {
      expect(mediaSessionHasNext(49, 50, "off", true)).toBe(true);
    });

    it("is true on last track with repeat all", () => {
      expect(mediaSessionHasNext(49, 50, "all", false)).toBe(true);
    });
  });

  describe("mediaSessionHasPrevious", () => {
    it("is true on first track with repeat all", () => {
      expect(mediaSessionHasPrevious(0, 50, "all")).toBe(true);
    });
  });
});
