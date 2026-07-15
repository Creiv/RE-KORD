import { waitMs } from "./cdp.mjs";

const STUDIO_TAB_PATTERNS = {
  listen: /listen|ascolta/i,
  catalog: /discover|catalogo|catalog/i,
  download: /download|scarica/i,
  meta: /metadata|metadati/i,
  covers: /covers|copertine/i,
};

const LIB_BROWSE_PATTERNS = {
  artists: /artists|artisti/i,
  genres: /genres|generi/i,
  moods: /moods|umori/i,
  nebula: /nebula/i,
};

const BOTTOM_NAV_PATTERNS = {
  dashboard: /dashboard|home/i,
  studio: /studio/i,
  libreria: /library|libreria/i,
};

const MORE_SECTION_PATTERNS = {
  queue: /queue|coda/i,
  playlists: /playlists|playlist/i,
  favorites: /favorites|preferiti/i,
  recent: /recent|recenti/i,
  statistics: /statistics|statistiche/i,
  achievements: /achievements|traguardi|resonance/i,
  settings: /settings|impostazioni/i,
  gioco: /plectr|gioco|game/i,
};

export async function waitForAppReady(page, base, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/localhost|127\.0\.0\.1|client-shell|\/connect/i.test(url)) {
      await waitMs(2000);
      continue;
    }
    if (!/^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(url) && !url.includes("192.168.")) {
      await waitMs(2000);
      continue;
    }
    const ready = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return (
        text.length > 200 &&
        !/server url|scan qr|connect to/i.test(text.slice(0, 500))
      );
    });
    if (ready) return true;
    await waitMs(2000);
  }
  return false;
}

export async function gotoPath(page, base, path) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitMs(2000);
}

export async function clickBottomNav(page, section) {
  const pattern = BOTTOM_NAV_PATTERNS[section];
  if (!pattern) throw new Error(`Unknown bottom nav: ${section}`);
  const nav = page.locator(".mobile-bottom-nav button");
  const btn = nav.filter({ hasText: pattern }).first();
  await btn.click({ timeout: 10000 });
  await waitMs(2000);
}

export async function openMoreSheet(page) {
  const more = page
    .locator(".mobile-bottom-nav button")
    .filter({ hasText: /more|altro|menu/i })
    .first();
  await more.click({ timeout: 8000 });
  await waitMs(800);
}

export async function clickMoreSection(page, section) {
  const pattern = MORE_SECTION_PATTERNS[section];
  if (!pattern) throw new Error(`Unknown more section: ${section}`);
  await openMoreSheet(page);
  const link = page
    .locator('[role="dialog"] button, .sheetLink')
    .filter({ hasText: pattern })
    .first();
  await link.click({ timeout: 8000 });
  await waitMs(2000);
}

export async function clickStudioTab(page, tab) {
  const pattern = STUDIO_TAB_PATTERNS[tab];
  if (!pattern) throw new Error(`Unknown studio tab: ${tab}`);
  const btn = page
    .locator(
      ".view-page--studio .section-nav-tabs button, .view-page--studio .section-nav-tab",
    )
    .filter({ hasText: pattern })
    .first();
  await btn.click({ timeout: 10000 });
  await waitMs(1500);
}

export async function clickLibBrowse(page, browse) {
  const pattern = LIB_BROWSE_PATTERNS[browse];
  if (!pattern) throw new Error(`Unknown lib browse: ${browse}`);
  const btn = page
    .locator(
      ".library-page .section-nav-tabs button, .library-page .section-nav-tab, .library-browse .section-nav-tab",
    )
    .filter({ hasText: pattern })
    .first();
  await btn.click({ timeout: 10000 });
  await waitMs(1500);
}

function dockPlayButton(page) {
  return page
    .locator(
      '.player-dock2 button.player-bar2__ic--play[aria-label*="Play"], .player-dock2 button.player-bar2__ic--play[aria-label*="Riproduci"]',
    )
    .first();
}

export async function isPlaybackActive(page) {
  return page.evaluate(() => {
    const a = document.querySelector("audio");
    if (a && !a.paused && !a.ended) return true;
    if (document.documentElement.dataset.rekordNativePlaying === "1") return true;
    if (navigator.mediaSession?.playbackState === "playing") return true;

    const dockPlay = document.querySelector(
      ".player-dock2 button.player-bar2__ic--play",
    );
    const playLabel = dockPlay?.getAttribute("aria-label") ?? "";
    if (/pause|pausa/i.test(playLabel)) return true;

    const times = document.querySelector(".player-bar2__times");
    if (times) {
      const elapsed = times.querySelector("span")?.textContent?.trim() ?? "";
      const total =
        times.querySelector("span:last-child")?.textContent?.trim() ?? "";
      if (
        elapsed &&
        total &&
        elapsed !== "0:00" &&
        elapsed !== total
      ) {
        return true;
      }
    }
    return false;
  });
}

export async function ensurePlayback(page) {
  if (await isPlaybackActive(page)) return true;

  const dockPlay = dockPlayButton(page);
  if (await dockPlay.isVisible({ timeout: 1500 }).catch(() => false)) {
    await dockPlay.click({ timeout: 5000 }).catch(() => {});
    await waitMs(1500);
    if (await isPlaybackActive(page)) return true;
  }

  const playSel =
    'button[aria-label*="Play"], button[aria-label*="Riproduci"], .player-bar2__play, .player-dock2 button';

  await page.locator(playSel).first().click({ timeout: 5000 }).catch(() => {});
  await waitMs(1500);
  if (await isPlaybackActive(page)) return true;

  await page
    .locator(
      'button[aria-label*="Play all"], button[aria-label*="Riproduci tutto"], button[aria-label*="Play"]',
    )
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
  await waitMs(1500);
  return isPlaybackActive(page);
}

export async function pausePlayback(page) {
  const pauseSel =
    'button[aria-label*="Pause"], button[aria-label*="Pausa"], .player-bar2__play';
  await page.locator(pauseSel).first().click({ timeout: 5000 }).catch(() => {});
  await waitMs(800);
}

export async function readPageState(page) {
  return page.evaluate(() => {
    const path = location.pathname.replace(/^\/+/, "") || "dashboard";
    const studioPane = [...document.querySelectorAll(".section-nav-tab.is-on")]
      .map((el) => el.textContent?.trim())
      .find((t) =>
        /listen|discover|download|metadata|covers|ascolta|catalogo|metadati|copertine/i.test(
          t || "",
        ),
      );
    const libTab = [...document.querySelectorAll(".section-nav-tab.is-on")]
      .map((el) => el.textContent?.trim())
      .find((t) =>
        /artists|genres|moods|nebula|artisti|generi|umori/i.test(t || ""),
      );
    const studioPaneEl = document.querySelector(".studio-pane");
    const hasCatalogContent =
      Boolean(document.querySelector(".studio-catalog-pane")) ||
      Boolean(document.querySelector(".studio-catalog, .studio-catalog-web")) ||
      Boolean(document.querySelector(".tools-catalog"));
    const listenPane = document.querySelector(".studio-pane--listen");
    const canvasCount = document.querySelectorAll("canvas").length;
    const storedPane = localStorage.getItem("rekord-studio-pane");
    return {
      path,
      studioPane,
      libTab: libTab || null,
      hasStudioPane: Boolean(studioPaneEl),
      hasListenPane: Boolean(listenPane),
      hasCatalogContent,
      canvasCount,
      storedPane,
      hidden: document.hidden,
      bodyTextLen: document.body?.innerText?.length ?? 0,
    };
  });
}
