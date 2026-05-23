import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPlectrDifficulty,
  migratePlectrDifficulty,
  PLECTR_DIFFICULTY_KEY,
  savePlectrDifficulty,
} from "./plectrDifficultyStorage";

describe("plectrDifficultyStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("migratePlectrDifficulty", () => {
    it("keeps current difficulty ids", () => {
      expect(migratePlectrDifficulty("easy")).toBe("easy");
      expect(migratePlectrDifficulty("normal")).toBe("normal");
      expect(migratePlectrDifficulty("hard")).toBe("hard");
    });

    it("maps legacy extreme to hard", () => {
      expect(migratePlectrDifficulty("extreme")).toBe("hard");
    });

    it("defaults unknown values to easy", () => {
      expect(migratePlectrDifficulty(null)).toBe("easy");
      expect(migratePlectrDifficulty("insane")).toBe("easy");
    });
  });

  describe("load/save", () => {
    it("persists selection in localStorage", () => {
      savePlectrDifficulty("hard");
      expect(localStorage.getItem(PLECTR_DIFFICULTY_KEY)).toBe("hard");
      expect(loadPlectrDifficulty()).toBe("hard");
    });
  });
});
