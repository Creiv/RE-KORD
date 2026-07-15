import { execSync } from "node:child_process";
import { adb } from "./setup.mjs";

/** Soglie CPU (% device, 0–100) con alwaysPlay attivo. */
const THRESHOLDS = {
  idle_dashboard: { cpuDevicePct: 15, pssMb: 260 },
  library_artists: { cpuDevicePct: 15, pssMb: 260 },
  nebula_play: { cpuDevicePct: 35, pssMb: 260 },
  studio_catalog: { cpuDevicePct: 18, pssMb: 260 },
  studio_listen: { cpuDevicePct: 40, pssMb: 270 },
  background_play: { cpuDevicePct: 8, pssMb: 205 },
  screen_off_play: { cpuDevicePct: 8, pssMb: 200 },
};

const coreCountCache = new Map();

export function detectCoreCount(device) {
  if (coreCountCache.has(device)) return coreCountCache.get(device);
  let cores = 1;
  try {
    const nproc = adb(device, "shell nproc").trim();
    const n = Number(nproc);
    if (Number.isFinite(n) && n > 0) cores = n;
  } catch {
    try {
      const cpuinfo = adb(device, "shell grep -c ^processor /proc/cpuinfo").trim();
      const n = Number(cpuinfo);
      if (Number.isFinite(n) && n > 0) cores = n;
    } catch {
      /* keep 1 */
    }
  }
  coreCountCache.set(device, cores);
  return cores;
}

export function samplePss(device) {
  const out = adb(device, `shell dumpsys meminfo app.rekord.client`);
  const total = out.match(/TOTAL PSS:\s*(\d+)/);
  const totalAlt = out.match(/TOTAL\s+(\d+)/);
  return {
    totalPssKb: Number(total?.[1] || totalAlt?.[1] || 0),
    totalPssMb: Number(total?.[1] || totalAlt?.[1] || 0) / 1024,
  };
}

export function sampleCpu(device, pid, seconds = 12) {
  const iterations = Math.max(1, Math.ceil(seconds / 2));
  const cpus = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const out = adb(
        device,
        `shell "top -n 1 -d 1 -s 9 2>/dev/null | grep -E 'rekord|${pid}'"`,
      );
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 9) {
          const cpu = Number(parts[8]);
          if (!Number.isNaN(cpu)) {
            cpus.push(cpu);
            break;
          }
        }
      }
    } catch {
      /* skip */
    }
    if (i < iterations - 1) {
      execSync("sleep 2");
    }
  }
  const avg = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  const max = cpus.length ? Math.max(...cpus) : null;
  return { avg, max, samples: cpus.length, raw: cpus };
}

/** Normalizza CPU top (somma core) in % device e metriche raw. */
export function enrichCpuMetrics(device, cpu) {
  const cores = detectCoreCount(device);
  const toDevicePct = (raw) => (raw != null ? raw / cores : null);
  return {
    cpuRawAvg: cpu.avg,
    cpuRawMax: cpu.max,
    cpuDevicePctAvg: toDevicePct(cpu.avg),
    cpuDevicePctMax: toDevicePct(cpu.max),
    cpuCores: cores,
    cpuSamples: cpu.samples,
    cpuRaw: cpu.raw,
  };
}

export function checkThresholds(scenarioId, metrics) {
  const t = THRESHOLDS[scenarioId];
  if (!t) return { withinThreshold: true, violations: [] };
  const violations = [];
  const deviceAvg = metrics.cpuDevicePctAvg ?? metrics.cpuAvg;
  if (deviceAvg != null && deviceAvg > t.cpuDevicePct) {
    const raw = metrics.cpuRawAvg ?? "?";
    const cores = metrics.cpuCores ?? "?";
    violations.push(
      `CPU device avg ${deviceAvg.toFixed(1)}% > ${t.cpuDevicePct}% (raw ${typeof raw === "number" ? raw.toFixed(1) : raw}% / ${cores} cores)`,
    );
  }
  if (metrics.pssMb != null && metrics.pssMb > t.pssMb) {
    violations.push(`PSS ${metrics.pssMb.toFixed(0)} MB > ${t.pssMb} MB`);
  }
  return { withinThreshold: violations.length === 0, violations };
}

export async function canvasAnimating(page) {
  return page.evaluate(async () => {
    const canvas = [...document.querySelectorAll("canvas")].find(
      (c) => c.width > 100 && c.height > 100,
    );
    if (!canvas) return { hasCanvas: false, animating: false };
    const ctx = canvas.getContext("2d");
    if (!ctx) return { hasCanvas: true, animating: false };
    const snap = () =>
      ctx
        .getImageData(0, 0, Math.min(32, canvas.width), Math.min(32, canvas.height))
        .data.join(",");
    const samples = [snap()];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 700));
      samples.push(snap());
    }
    return { hasCanvas: true, animating: new Set(samples).size > 1 };
  });
}
