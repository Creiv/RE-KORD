import { describe, expect, it } from "vitest";
import {
  isAllowedThemeBgFile,
  THEME_BG_MAX_BYTES,
  themeBgAcceptAttribute,
  validateThemeBgFile,
} from "./themeBgFile";

describe("themeBgFile", () => {
  it("accepts gif by mime or extension", () => {
    expect(isAllowedThemeBgFile(new File([], "loop.gif", { type: "image/gif" }))).toBe(
      true,
    );
    expect(isAllowedThemeBgFile(new File([], "loop.gif", { type: "" }))).toBe(true);
    expect(isAllowedThemeBgFile(new File([], "photo.jpg", { type: "" }))).toBe(true);
    expect(isAllowedThemeBgFile(new File([], "doc.pdf", { type: "" }))).toBe(false);
  });

  it("includes gif in accept attribute", () => {
    expect(themeBgAcceptAttribute()).toContain("image/gif");
    expect(themeBgAcceptAttribute()).toContain(".gif");
  });

  it("rejects files over max size", () => {
    const big = new File([new Uint8Array(THEME_BG_MAX_BYTES + 1)], "big.gif", {
      type: "image/gif",
    });
    expect(validateThemeBgFile(big)).toBe("size");
  });
});
