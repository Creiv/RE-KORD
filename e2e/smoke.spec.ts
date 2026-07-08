import { test, expect } from "@playwright/test";

test("app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});

test("navigate core sections", async ({ page }) => {
  await page.goto("/");
  for (const hash of ["#dashboard", "#libreria", "#studio", "#impostazioni"]) {
    await page.goto(`/${hash}`);
    await expect(page.locator("body")).toBeVisible();
  }
});

test("settings persist locale toggle", async ({ page }) => {
  await page.goto("/#impostazioni");
  await expect(page.locator("body")).toBeVisible();
});

test("library search input visible", async ({ page }) => {
  await page.goto("/#libreria");
  await expect(page.locator("body")).toBeVisible();
});

test("health API reachable through proxy", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:3001/api/health");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("diagnostics API reachable", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:3001/api/diagnostics");
  expect(res.ok()).toBeTruthy();
});
