import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export async function connectCdp(port = 9222) {
  const pages = JSON.parse(
    execSync(`curl -s http://127.0.0.1:${port}/json`, { encoding: "utf8" }),
  );
  if (!pages.length) throw new Error("Nessuna pagina CDP");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  let page = context.pages()[0] ?? (await context.newPage());
  let base = new URL(page.url()).origin;
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    for (const p of context.pages()) {
      const origin = new URL(p.url()).origin;
      if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(origin)) {
        page = p;
        base = origin;
        break;
      }
    }
  }
  return { browser, page, base, pages };
}

export function attachErrorCapture(page, bucket) {
  page.on("pageerror", (err) => {
    bucket.pageErrors.push(String(err));
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") bucket.consoleErrors.push(msg.text());
    if (msg.type() === "warning") bucket.consoleWarnings.push(msg.text());
  });
}

export async function screenshotOnFail(page, label, outDir) {
  mkdirSync(outDir, { recursive: true });
  const safe = label.replace(/[^a-z0-9_-]+/gi, "_");
  const path = join(outDir, `${safe}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  return path;
}

export async function waitMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
