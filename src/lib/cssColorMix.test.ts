import { describe, expect, it } from "vitest";
import {
  mixSrgbColors,
  mixSrgbWithTransparent,
  parseCssColor,
} from "./cssColorMix";

describe("parseCssColor", () => {
  it("parses rgba", () => {
    expect(parseCssColor("rgba(18, 30, 46, 0.9)")).toEqual({
      r: 18,
      g: 30,
      b: 46,
      a: 0.9,
    });
  });

  it("parses hex", () => {
    expect(parseCssColor("#ff8040")).toEqual({
      r: 255,
      g: 128,
      b: 64,
      a: 1,
    });
  });
});

describe("mixSrgbWithTransparent", () => {
  it("keeps partial opacity when mixing with transparent", () => {
    const base = parseCssColor("rgba(18, 30, 46, 0.9)")!;
    const mixed = mixSrgbWithTransparent(base, 62);
    const out = parseCssColor(mixed);
    expect(out).not.toBeNull();
    expect(out!.a).toBeGreaterThan(0.4);
    expect(out!.a).toBeLessThan(0.7);
  });
});

describe("mixSrgbColors", () => {
  it("mixes two opaque colors", () => {
    const a = parseCssColor("#000000")!;
    const b = parseCssColor("#ffffff")!;
    expect(mixSrgbColors(a, 50, b, 50)).toBe("rgba(128, 128, 128, 1)");
  });
});
