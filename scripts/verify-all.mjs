#!/usr/bin/env node
/**
 * Gate standard per ogni stage del piano performance RE-KORD.
 * Esegue lint → typecheck → test → test:integration → build in sequenza.
 * Opzionale: --e2e per includere Playwright (milestone di fase).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const includeE2e = process.argv.includes("--e2e");

const steps = [
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
  { name: "test", cmd: "npm", args: ["run", "test"] },
  { name: "test:integration", cmd: "npm", args: ["run", "test:integration"] },
  { name: "build", cmd: "npm", args: ["run", "build"] },
];

if (includeE2e) {
  steps.push({ name: "test:e2e", cmd: "npm", args: ["run", "test:e2e"] });
}

for (const step of steps) {
  console.log(`\n[verify-all] ▶ ${step.name}`);
  const result = spawnSync(step.cmd, step.args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\n[verify-all] ✗ ${step.name} failed (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
  console.log(`[verify-all] ✓ ${step.name}`);
}

console.log("\n[verify-all] All checks passed.");
