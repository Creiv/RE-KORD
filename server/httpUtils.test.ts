import { describe, expect, it } from "vitest";
import { apiSkipsLibraryGate } from "./httpUtils.mjs";

describe("apiSkipsLibraryGate", () => {
  it("consente public-ip senza libreria configurata", () => {
    expect(
      apiSkipsLibraryGate({ path: "/network/public-ip", method: "GET" }),
    ).toBe(true);
  });

  it("continua a richiedere libreria per altre API", () => {
    expect(apiSkipsLibraryGate({ path: "/library-index", method: "GET" })).toBe(
      false,
    );
  });
});
