import { describe, expect, it } from "vitest";
import {
  bundledBinCandidates,
  pathLooksLikeAsarArchive,
  resolveBundledBinPath,
} from "./bundledBin.mjs";

describe("bundledBin", () => {
  it("include sempre il binario di sviluppo server/bin", () => {
    const candidates = bundledBinCandidates("cloudflared");
    expect(candidates.at(-1)).toMatch(/server[\\/]bin[\\/]cloudflared$/);
  });

  it("risolve cloudflared nel tree di sviluppo", () => {
    const resolved = resolveBundledBinPath("cloudflared");
    if (resolved) {
      expect(resolved).toMatch(/server\/bin\/cloudflared$/);
      expect(pathLooksLikeAsarArchive(resolved)).toBe(false);
    }
  });

  it("rileva path dentro app.asar", () => {
    expect(
      pathLooksLikeAsarArchive(
        "/opt/RE-KORD/resources/app.asar/server/bin/cloudflared",
      ),
    ).toBe(true);
  });
});
