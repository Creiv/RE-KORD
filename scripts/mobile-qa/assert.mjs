import { readPageState } from "./nav.mjs";

export function makeResult(id, label) {
  return {
    id,
    label,
    ok: false,
    errors: [],
    warnings: [],
    state: null,
    screenshot: null,
  };
}

export async function assertStudioTab(page, tab, expect) {
  const state = await readPageState(page);
  const errors = [];
  if (state.bodyTextLen < 50) {
    errors.push("Pagina quasi vuota (bodyTextLen < 50)");
  }
  if (tab === "listen" && expect.listen && !state.hasListenPane) {
    errors.push("Tab Ascolta attiva ma .studio-pane--listen assente");
  }
  if (tab === "catalog" && expect.catalog && !state.hasCatalogContent) {
    errors.push("Tab Catalogo attiva ma contenuto catalogo assente");
  }
  if (tab === "download" && expect.download) {
    const hasDl = await page
      .locator(".studio-download, .tools-download, input[type='url'], input[type='text']")
      .count();
    if (hasDl === 0) errors.push("Tab Download senza input/contenuto");
  }
  if (tab === "meta" && expect.meta) {
    const hasMeta = await page
      .locator(".tools-meta, .studio-meta-split")
      .count();
    if (hasMeta === 0) errors.push("Tab Meta senza pannello");
  }
  if (tab === "covers" && expect.covers) {
    const hasCovers = await page
      .locator(".studio-covers, .album-editor")
      .count();
    if (hasCovers === 0) {
      const alt = await page.locator("text=/cover|copertin/i").count();
      if (alt === 0) errors.push("Tab Copertine senza contenuto");
    }
  }
  return { state, errors };
}

export async function assertSectionLoaded(page, section) {
  const state = await readPageState(page);
  const errors = [];
  if (state.bodyTextLen < 30) {
    errors.push(`Sezione ${section}: contenuto insufficiente`);
  }
  if (section === "dashboard") {
    const cards = await page.locator(".surface-card, .dashboard-card").count();
    if (cards === 0) errors.push("Dashboard senza card");
  }
  if (section === "libreria") {
    const lib = await page.locator(".library-page, .library-browse").count();
    if (lib === 0) errors.push("Library view non montata");
  }
  if (section === "settings") {
    const settings = await page
      .locator(
        ".settings-section, .settings-account-section, .settings-network-section, .surface-card",
      )
      .count();
    if (settings === 0) errors.push("Settings senza sezioni");
  }
  return { state, errors };
}

export function drainCapture(capture) {
  const local = { pageErrors: [...capture.pageErrors], consoleErrors: [] };
  capture.pageErrors.length = 0;
  return local;
}

export function finalizeResult(result, capture, fatals = []) {
  result.state = capture.state ?? result.state;
  if (capture.pageErrors?.length) {
    const significant = capture.pageErrors.filter(
      (e) =>
        !/Capacitor\.triggerEvent is not a function/.test(e),
    );
    result.errors.push(...significant.map((e) => `pageerror: ${e}`));
  }
  if (fatals.length) {
    result.errors.push(...fatals.map((f) => `logcat: ${f}`));
  }
  result.ok = result.errors.length === 0;
  return result;
}
