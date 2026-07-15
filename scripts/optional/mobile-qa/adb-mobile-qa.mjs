#!/usr/bin/env node
/**
 * QA mobile RE-KORD via ADB + CDP WebView.
 *
 * Uso:
 *   node scripts/optional/mobile-qa/adb-mobile-qa.mjs              # matrice completa
 *   node scripts/optional/mobile-qa/adb-mobile-qa.mjs --only studio
 *   node scripts/optional/mobile-qa/adb-mobile-qa.mjs --perf
 *   node scripts/optional/mobile-qa/adb-mobile-qa.mjs --with-perf
 */
import { runMatrix } from "./matrix.mjs";

const args = process.argv.slice(2);
const opts = {
  only: args.includes("--only")
    ? args[args.indexOf("--only") + 1]
    : null,
  perf: args.includes("--perf"),
  withPerf: args.includes("--with-perf"),
  perfSec: Number(process.env.PERF_SEC || 20),
  cdpPort: Number(process.env.CDP_PORT || 9222),
};

try {
  const report = await runMatrix(opts);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.benchmark?.length) {
    console.log("\nBenchmark:");
    for (const b of report.benchmark) {
      const status = b.withinThreshold === false ? "FAIL" : "OK";
      const deviceCpu = b.cpuDevicePctAvg?.toFixed?.(1) ?? "?";
      const rawCpu = b.cpuRawAvg?.toFixed?.(1) ?? "?";
      const cores = b.cpuCores ?? "?";
      console.log(
        `  [${status}] ${b.id}: CPU device ${deviceCpu}% (raw ${rawCpu}% / ${cores} cores) PSS ${b.pssMb?.toFixed?.(0) ?? "?"} MB`,
      );
      if (b.violations?.length) console.log(`    ${b.violations.join("; ")}`);
    }
  }
  if (report.results?.length) {
    const failed = report.results.filter((r) => !r.ok);
    if (failed.length) {
      console.log("\nFalliti:");
      for (const f of failed) {
        console.log(`  - ${f.id}: ${f.errors.join("; ")}`);
      }
    }
  }
  console.log(`\nReport: ${report.outFile}`);
  const exitCode =
    (report.summary.failed ?? 0) > 0 ||
    report.benchmark?.some((b) => b.withinThreshold === false)
      ? 1
      : 0;
  process.exit(exitCode);
} catch (err) {
  console.error(err);
  process.exit(1);
}
