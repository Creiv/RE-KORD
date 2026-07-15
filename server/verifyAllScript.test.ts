// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("verify-all script", () => {
  it("esiste ed esporta gli step del gate standard", () => {
    const scriptPath = path.join(root, "scripts", "verify-all.mjs");
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("lint");
    expect(source).toContain("typecheck");
    expect(source).toContain("test:integration");
    expect(source).toContain("build");
    expect(source).toContain("--e2e");
  });

  it("package.json definisce npm run verify", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts.verify).toBe("node scripts/verify-all.mjs");
  });
});
