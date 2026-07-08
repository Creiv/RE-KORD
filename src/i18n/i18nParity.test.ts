import { describe, expect, it } from "vitest";
import { EN } from "./en";
import { IT } from "./it";

describe("i18n parity EN/IT", () => {
  it("every EN key exists in IT", () => {
    const missing = Object.keys(EN).filter((key) => !(key in IT));
    expect(missing).toEqual([]);
  });

  it("every IT key exists in EN", () => {
    const missing = Object.keys(IT).filter((key) => !(key in EN));
    expect(missing).toEqual([]);
  });
});
