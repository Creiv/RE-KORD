/**
 * Misura main-thread / long-task su preview locale mentre i viz dell'app girano.
 * Uso: node scripts/perf-browser.mjs [--mobile]
 */
/* eslint-disable no-undef -- page.evaluate() runs in browser context */
import { chromium, devices } from "@playwright/test";

const mobile = process.argv.includes("--mobile");
const baseURL = process.env.PERF_BASE_URL || "http://127.0.0.1:4173";
const routes = [
  { path: "/", label: "dashboard" },
  { path: "/studio", label: "ascolta" },
  { path: "/libreria", label: "nebula", setup: "nebula" },
];

async function prepareRoute(page, route) {
  await page.goto(`${baseURL}${route.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  if (route.path === "/studio") {
    await page
      .locator(
        ".player-dock2 button[aria-label*='Play'], .player-dock2 button[aria-label*='Riproduci'], .player-bar2__play",
      )
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1200);
  }

  if (route.setup === "nebula") {
    await page
      .locator("button, [role='tab']")
      .filter({ hasText: /nebula/i })
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector("canvas", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(mobile ? 1500 : 1000);
}

async function measureRoute(page, route) {
  await prepareRoute(page, route);

  const stats = await page.evaluate(async () => {
    const canvasCount = document.querySelectorAll("canvas").length;
    let vizCanvas = 0;
    for (const c of document.querySelectorAll("canvas")) {
      const w = c.width;
      const h = c.height;
      if (w > 0 && h > 0) vizCanvas += 1;
    }

    let longTasks = 0;
    let longTaskMs = 0;
    const obs =
      typeof PerformanceObserver !== "undefined"
        ? new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.duration >= 50) {
                longTasks += 1;
                longTaskMs += e.duration;
              }
            }
          })
        : null;
    try {
      obs?.observe({ entryTypes: ["longtask"] });
    } catch {
      /* unsupported */
    }

    let paintCount = 0;
    let paintObs = null;
    try {
      paintObs = new PerformanceObserver((list) => {
        paintCount += list.getEntries().length;
      });
      paintObs.observe({ entryTypes: ["paint", "long-animation-frame"] });
    } catch {
      /* unsupported */
    }

    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const elapsed = performance.now() - t0;

    obs?.disconnect();
    paintObs?.disconnect();

    const audio = document.querySelector("audio");
    const playing = Boolean(audio && !audio.paused && !audio.ended);

    return {
      canvasCount,
      vizCanvas,
      longTasks,
      longTaskMs: Math.round(longTaskMs),
      paintsPerSec: Math.round((paintCount / elapsed) * 1000),
      hidden: document.hidden,
      playing,
    };
  });

  return { route: route.label, ...stats };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(
  mobile
    ? { ...devices["Pixel 5"], locale: "it-IT" }
    : { viewport: { width: 1280, height: 800 }, locale: "it-IT" },
);
const page = await context.newPage();

console.log(`\n=== Browser perf (${mobile ? "mobile" : "desktop"}) ${baseURL} ===\n`);
const results = [];
for (const route of routes) {
  try {
    results.push(await measureRoute(page, route));
  } catch (err) {
    results.push({ route: route.label, error: String(err) });
  }
}

console.table(results);
await browser.close();
