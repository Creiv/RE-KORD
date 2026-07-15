import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realPathUnderRoot, underRoot } from "./pathSafety.mjs";

describe("realPathUnderRoot", () => {
  it("accepts existing files inside the library", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rekord-root-"));
    const file = path.join(root, "track.mp3");
    writeFileSync(file, "audio");

    expect(underRoot(file, root)).toBe(true);
    expect(realPathUnderRoot(file, root)).toBe(true);
  });

  it("rejects a symlink that escapes the library", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rekord-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "rekord-outside-"));
    const secret = path.join(outside, "secret.mp3");
    writeFileSync(secret, "secret");
    mkdirSync(path.join(root, "Artist"));
    const link = path.join(root, "Artist", "linked.mp3");
    symlinkSync(secret, link);

    expect(underRoot(link, root)).toBe(true);
    expect(realPathUnderRoot(link, root)).toBe(false);
  });
});
