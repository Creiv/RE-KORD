/**
 * Validazione ADB + CDP WebView Android per RE-KORD.
 * Uso: node scripts/optional/mobile-qa/adb-webview-cdp-validate.mjs
 */
import { execSync, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const DEVICE = process.env.ADB_DEVICE || "afaa4085";
const PKG = "app.rekord.client";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC || 30);
const SAMPLE_INTERVAL_MS = 2000;

function adb(...args) {
  return execSync(["adb", "-s", DEVICE, ...args].join(" "), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setupForward() {
  const pid = adb(`shell pidof ${PKG}`).split(/\s+/)[0];
  if (!pid) throw new Error(`App ${PKG} non in esecuzione`);
  try {
    adb("forward", "--remove", `tcp:${CDP_PORT}`);
  } catch {
    /* ignore */
  }
  adb(
    "forward",
    `tcp:${CDP_PORT}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
  const pages = JSON.parse(
    execSync(`curl -s http://127.0.0.1:${CDP_PORT}/json`, { encoding: "utf8" }),
  );
  if (!pages.length) throw new Error("Nessuna pagina CDP");
  return { pid: Number(pid), pages };
}

function sampleCpu(pid, seconds) {
  const iterations = Math.max(1, Math.ceil(seconds / 2));
  const cpus = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const out = adb(
        `shell "top -n 1 -d 1 -s 9 2>/dev/null | grep -E 'rekord|${pid}'"`,
      );
      for (const line of out.split("\n")) {
        const m = line.match(/(\d+(?:\.\d+)?)\s*$/);
        if (m) {
          cpus.push(Number(m[1]));
          break;
        }
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
      /* skip sample */
    }
    if (i < iterations - 1) {
      execSync("sleep 2");
    }
  }
  const avg = cpus.length
    ? cpus.reduce((a, b) => a + b, 0) / cpus.length
    : null;
  const max = cpus.length ? Math.max(...cpus) : null;
  return { samples: cpus.length, avg, max, raw: cpus };
}

function samplePss() {
  const out = adb(`shell dumpsys meminfo ${PKG}`);
  const total = out.match(/TOTAL PSS:\s*(\d+)/);
  const totalAlt = out.match(/TOTAL\s+(\d+)/);
  const native = out.match(/Native Heap\s+(\d+)/);
  return {
    totalPssKb: Number(total?.[1] || totalAlt?.[1] || 0),
    nativeHeapKb: Number(native?.[1] || 0),
  };
}

async function waitMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function navDashboard(page, base) {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await waitMs(2500);
}

async function navLibraryNebula(page, base) {
  await page.goto(`${base}/libreria`, { waitUntil: "domcontentloaded" });
  await waitMs(1500);
  await page
    .locator("button, [role='tab']")
    .filter({ hasText: /nebula/i })
    .first()
    .click({ timeout: 8000 })
    .catch(() => {});
  await page.waitForSelector("canvas", { timeout: 12000 }).catch(() => {});
  await waitMs(2000);
}

async function navStudioCatalog(page, base) {
  await page.goto(`${base}/studio`, { waitUntil: "domcontentloaded" });
  await waitMs(1500);
  const catalogBtn = page
    .locator("button")
    .filter({ has: page.locator(".section-head__ic") })
    .nth(1);
  await catalogBtn.click({ timeout: 8000 }).catch(async () => {
    await page
      .locator('[aria-label="Sezioni Studio"] button')
      .nth(1)
      .click({ timeout: 5000 })
      .catch(() => {});
  });
  await waitMs(2000);
}

async function navBackground(page) {
  adb('shell input keyevent KEYCODE_HOME');
  await waitMs(3000);
}

async function navForeground(page) {
  adb(`shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  await waitMs(2500);
}

async function ensurePlayback(page) {
  const playSel =
    '.player-dock2 button[aria-label*="Riproduci"], .player-dock2 button[aria-label*="Play"], .player-bar2__play';
  const playBtn = page.locator(playSel).first();
  const playing = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return Boolean(a && !a.paused && !a.ended);
  });
  if (playing) return true;

  await playBtn.click({ timeout: 5000 }).catch(() => {});
  await waitMs(1200);
  let ok = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return Boolean(a && !a.paused && !a.ended);
  });
  if (ok) return true;

  await page
    .locator('button[aria-label*="Riproduci"]')
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await waitMs(1200);
  ok = await page.evaluate(() => {
    const a = document.querySelector("audio");
    return Boolean(a && !a.paused && !a.ended);
  });
  return ok;
}

async function canvasAnimating(page) {
  return page.evaluate(async () => {
    const canvas = [...document.querySelectorAll("canvas")].find(
      (c) => c.width > 100 && c.height > 100,
    );
    if (!canvas) return { hasCanvas: false, animating: false, canvasCount: 0 };
    const ctx = canvas.getContext("2d");
    if (!ctx) return { hasCanvas: true, animating: false, canvasCount: 1 };
    const snap = () =>
      ctx
        .getImageData(
          0,
          0,
          Math.min(32, canvas.width),
          Math.min(32, canvas.height),
        )
        .data.join(",");
    const samples = [snap()];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 700));
      samples.push(snap());
    }
    const unique = new Set(samples).size;
    const audio = document.querySelector("audio");
    return {
      hasCanvas: true,
      animating: unique > 1,
      uniqueFrames: unique,
      canvasCount: document.querySelectorAll("canvas").length,
      size: `${canvas.width}x${canvas.height}`,
      playing: Boolean(audio && !audio.paused),
    };
  });
}

async function measureScenario(page, pid, label, prep, opts = {}) {
  await prep();
  const playing = opts.skipPlayback
    ? null
    : await ensurePlayback(page);
  const pssBefore = samplePss();
  const cpu = sampleCpu(pid, SAMPLE_SEC);
  const pssAfter = samplePss();
  const canvas = opts.skipCanvas ? null : await canvasAnimating(page);
  const url = opts.skipCanvas ? "(background)" : page.url();
  const section = opts.skipCanvas
    ? { path: "background", libTab: null, hidden: true }
    : await page.evaluate(() => {
        const path = location.pathname.replace(/^\/+/, "") || "dashboard";
        const libTab = [...document.querySelectorAll("button,[role='tab']")]
          .find(
            (el) =>
              el.getAttribute("aria-selected") === "true" ||
              el.classList.contains("is-on"),
          )
          ?.textContent?.trim();
        return { path, libTab: libTab || null, hidden: document.hidden };
      });
  return {
    label,
    url,
    section,
    playing,
    cpuAvg: cpu.avg,
    cpuMax: cpu.max,
    cpuSamples: cpu.samples,
    pssKb: pssAfter.totalPssKb || pssBefore.totalPssKb,
    nativeKb: pssAfter.nativeHeapKb || pssBefore.nativeHeapKb,
    canvas,
  };
}

async function testTabPause(page, pid, base) {
  await navLibraryNebula(page, base);
  await ensurePlayback(page);
  const cpuNebula = sampleCpu(pid, 12);
  const canvasBefore = await canvasAnimating(page);
  await navStudioCatalog(page, base);
  await waitMs(3000);
  const cpuStudio = sampleCpu(pid, 12);
  const canvasAfter = await canvasAnimating(page);
  return {
    cpuNebulaAvg: cpuNebula.avg,
    cpuStudioAvg: cpuStudio.avg,
    cpuDelta: cpuNebula.avg != null && cpuStudio.avg != null
      ? cpuNebula.avg - cpuStudio.avg
      : null,
    canvasBefore,
    canvasAfter,
  };
}

const report = {
  cdp: { ok: false, error: null, pid: null, pageUrl: null },
  navigation: [],
  scenarios: [],
  tabPause: null,
};

try {
  const { pid, pages } = setupForward();
  report.cdp.ok = true;
  report.cdp.pid = pid;
  report.cdp.pageUrl = pages[0]?.url;

  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${CDP_PORT}`,
  );
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const base = new URL(page.url()).origin;

  const scenarios = [
    { label: "dashboard_preview", prep: () => navDashboard(page, base) },
    { label: "nebula_fullscreen", prep: () => navLibraryNebula(page, base) },
    { label: "studio_catalog", prep: () => navStudioCatalog(page, base) },
    {
      label: "background_playback",
      prep: async () => {
        await navLibraryNebula(page, base);
        await ensurePlayback(page);
        await navBackground(page);
      },
      after: () => navForeground(page),
      opts: { skipPlayback: true, skipCanvas: true },
    },
  ];

  for (const s of scenarios) {
    try {
      const r = await measureScenario(page, pid, s.label, s.prep, s.opts);
      report.scenarios.push(r);
      report.navigation.push({ view: s.label, ok: true, url: r.url });
      if (s.after) await s.after();
    } catch (err) {
      report.scenarios.push({ label: s.label, error: String(err) });
      report.navigation.push({ view: s.label, ok: false, error: String(err) });
    }
  }

  try {
    report.tabPause = await testTabPause(page, pid, base);
  } catch (err) {
    report.tabPause = { error: String(err) };
  }

  await browser.close();
} catch (err) {
  report.cdp.error = String(err);
}

console.log(JSON.stringify(report, null, 2));
