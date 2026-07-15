import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  adbHome,
  adbScreenOff,
  adbWake,
  clearLogcat,
  readFatalLogcat,
  resolveDevice,
  setupCdpForward,
} from "./setup.mjs";
import {
  attachErrorCapture,
  connectCdp,
  screenshotOnFail,
  waitMs,
} from "./cdp.mjs";
import {
  clickBottomNav,
  clickLibBrowse,
  clickStudioTab,
  ensurePlayback,
  gotoPath,
  isPlaybackActive,
  pausePlayback,
  readPageState,
  waitForAppReady,
} from "./nav.mjs";
import {
  assertSectionLoaded,
  assertStudioTab,
  finalizeResult,
  drainCapture,
  makeResult,
} from "./assert.mjs";
import {
  canvasAnimating,
  checkThresholds,
  enrichCpuMetrics,
  sampleCpu,
  samplePss,
} from "./perf.mjs";

const STUDIO_TABS = ["listen", "catalog", "download", "meta", "covers"];
const LIB_BROWSES = ["artists", "genres", "moods", "nebula"];

async function finishScenario(result, page, capture, opts, samplePerf = false) {
  if (opts.alwaysPlay) {
    const playing = await isPlaybackActive(page);
    if (!playing) {
      const recovered = await ensurePlayback(page);
      if (!recovered) {
        result.errors.push("Playback non attivo durante scenario");
      } else {
        result.warnings.push("Playback ripristinato dopo navigazione");
      }
    }
    result.state = {
      ...(result.state ?? {}),
      playing: await isPlaybackActive(page),
    };
  }
  if (samplePerf && opts.device && opts.pid) {
    const cpu = enrichCpuMetrics(
      opts.device,
      sampleCpu(opts.device, opts.pid, opts.perfSampleSec ?? 8),
    );
    const pss = samplePss(opts.device);
    result.state = {
      ...(result.state ?? {}),
      ...cpu,
      pssMb: pss.totalPssMb,
    };
  }
  finalizeResult(result, drainCapture(capture), readFatalLogcat(opts.device));
}

async function runStudioMatrix(page, base, capture, opts) {
  const results = [];
  const entries = [
    { via: "goto", fn: () => gotoPath(page, base, "/studio") },
    { via: "bottomNav", fn: () => clickBottomNav(page, "studio") },
  ];
  for (const entry of entries) {
    for (const tab of STUDIO_TABS) {
      const id = `studio_${entry.via}_${tab}`;
      const result = makeResult(id, `Studio (${entry.via}) tab ${tab} + play`);
      try {
        await entry.fn();
        await clickStudioTab(page, tab);
        await waitMs(1500);
        const { state, errors } = await assertStudioTab(page, tab, {
          listen: true,
          catalog: true,
          download: true,
          meta: true,
          covers: true,
        });
        result.state = state;
        result.errors.push(...errors);
        if (!opts.perfOnly) {
          await finishScenario(result, page, capture, opts, true);
        } else {
          result.ok = errors.length === 0;
        }
      } catch (err) {
        result.errors.push(String(err));
        result.screenshot = await screenshotOnFail(page, id, opts.outDir);
      }
      results.push(result);
    }
  }
  return results;
}

async function runCoreMatrix(page, base, capture, opts) {
  const results = [];

  const dash = makeResult("core_dashboard", "Dashboard + play");
  try {
    await gotoPath(page, base, "/");
    const { state, errors } = await assertSectionLoaded(page, "dashboard");
    dash.state = state;
    dash.errors.push(...errors);
    await finishScenario(dash, page, capture, opts, true);
  } catch (err) {
    dash.errors.push(String(err));
    dash.screenshot = await screenshotOnFail(page, "core_dashboard", opts.outDir);
  }
  results.push(dash);

  for (const browse of LIB_BROWSES) {
    const r = makeResult(`core_library_${browse}`, `Library ${browse} + play`);
    try {
      await gotoPath(page, base, "/libreria");
      await clickLibBrowse(page, browse);
      await waitMs(1500);
      const state = await readPageState(page);
      r.state = state;
      if (state.bodyTextLen < 30) r.errors.push("Library browse vuota");
      if (browse === "nebula") {
        const canvas = await canvasAnimating(page);
        r.state = { ...state, canvas };
      }
      await finishScenario(r, page, capture, opts, true);
    } catch (err) {
      r.errors.push(String(err));
      r.screenshot = await screenshotOnFail(page, r.id, opts.outDir);
    }
    results.push(r);
  }

  results.push(...(await runStudioMatrix(page, base, capture, opts)));
  return results;
}

async function runSecondaryMatrix(page, base, capture, opts) {
  const results = [];
  const sections = [
    { id: "queue", path: "/queue" },
    { id: "playlists", path: "/playlists" },
    { id: "favorites", path: "/favorites" },
    { id: "recent", path: "/recent" },
    { id: "statistics", path: "/statistics" },
    { id: "achievements", path: "/achievements" },
    { id: "settings", path: "/settings" },
  ];
  for (const section of sections) {
    const r = makeResult(`secondary_${section.id}`, `${section.id} + play`);
    try {
      await gotoPath(page, base, section.path);
      await waitMs(1500);
      const { state, errors } = await assertSectionLoaded(page, section.id);
      r.state = state;
      r.errors.push(...errors);
      await finishScenario(r, page, capture, opts, true);
    } catch (err) {
      r.errors.push(String(err));
      r.screenshot = await screenshotOnFail(page, r.id, opts.outDir);
    }
    results.push(r);
  }

  for (const alias of [
    { path: "/ascolta", id: "alias_ascolta" },
    { path: "/nebula", id: "alias_nebula" },
    { path: "/resonance", id: "alias_resonance" },
  ]) {
    const r = makeResult(alias.id, `Legacy ${alias.path} + play`);
    try {
      await gotoPath(page, base, alias.path);
      await waitMs(1500);
      const state = await readPageState(page);
      r.state = state;
      if (state.bodyTextLen < 30) r.errors.push("Route legacy vuota");
      await finishScenario(r, page, capture, opts, true);
    } catch (err) {
      r.errors.push(String(err));
    }
    results.push(r);
  }
  return results;
}

async function runPlayerStressMatrix(page, base, capture, opts) {
  const results = [];
  const device = opts.device;
  const pid = opts.pid;

  const sustained = makeResult("player_sustained_fg", "Playback sostenuto FG 45s");
  try {
    await gotoPath(page, base, "/studio");
    await clickStudioTab(page, "listen");
    await ensurePlayback(page);
    const pss0 = samplePss(device);
    const cpu = enrichCpuMetrics(device, sampleCpu(device, pid, 45));
    const pss1 = samplePss(device);
    const leakMb = pss1.totalPssMb - pss0.totalPssMb;
    sustained.state = {
      playing: await isPlaybackActive(page),
      ...cpu,
      pssStartMb: pss0.totalPssMb,
      pssEndMb: pss1.totalPssMb,
      pssDeltaMb: leakMb,
    };
    if (leakMb > 15) {
      sustained.warnings.push(`Possibile crescita memoria: +${leakMb.toFixed(1)} MB`);
    }
    await finishScenario(sustained, page, capture, opts, false);
  } catch (err) {
    sustained.errors.push(String(err));
  }
  results.push(sustained);

  const bg = makeResult("player_bg_play", "Playback background 30s");
  try {
    await ensurePlayback(page);
    clearLogcat(device);
    adbHome(device);
    await waitMs(30000);
    const cpu = enrichCpuMetrics(device, sampleCpu(device, pid, 30));
    const pss = samplePss(device);
    bg.state = { ...cpu, pssMb: pss.totalPssMb };
    adbWake(device);
    await waitMs(2000);
    await finishScenario(bg, page, capture, opts, false);
  } catch (err) {
    bg.errors.push(String(err));
    adbWake(device);
  }
  results.push(bg);

  const off = makeResult("player_screen_off", "Playback screen off 15s");
  try {
    await ensurePlayback(page);
    adbScreenOff(device);
    await waitMs(15000);
    const cpu = enrichCpuMetrics(device, sampleCpu(device, pid, 15));
    const pss = samplePss(device);
    off.state = { ...cpu, pssMb: pss.totalPssMb };
    adbScreenOff(device);
    await waitMs(1000);
    adbWake(device);
    await waitMs(2000);
    await finishScenario(off, page, capture, opts, false);
  } catch (err) {
    off.errors.push(String(err));
    adbWake(device);
  }
  results.push(off);

  return results;
}

const PERF_SETTLE_MS = 5000;

async function runPerfBenchmark(page, base, opts) {
  const device = opts.device;
  const pid = opts.pid;
  await ensurePlayback(page);

  const scenarios = [
    { id: "idle_dashboard", run: () => gotoPath(page, base, "/") },
    {
      id: "library_artists",
      run: async () => {
        await gotoPath(page, base, "/libreria");
        await clickLibBrowse(page, "artists");
      },
    },
    {
      id: "nebula_play",
      run: async () => {
        await gotoPath(page, base, "/libreria");
        await clickLibBrowse(page, "nebula");
      },
    },
    {
      id: "studio_catalog",
      run: async () => {
        await gotoPath(page, base, "/studio");
        await clickStudioTab(page, "catalog");
      },
    },
    {
      id: "studio_listen",
      run: async () => {
        await gotoPath(page, base, "/studio");
        await clickStudioTab(page, "listen");
      },
    },
    {
      id: "background_play",
      run: async () => {
        await ensurePlayback(page);
        adbHome(device);
      },
      sampleInBg: true,
    },
  ];

  const bench = [];
  for (const s of scenarios) {
    try {
      await s.run();
      await waitMs(PERF_SETTLE_MS);
      await ensurePlayback(page);
      const cpu = enrichCpuMetrics(
        device,
        sampleCpu(device, pid, opts.perfSec ?? 20),
      );
      const pss = samplePss(device);
      const canvas =
        s.id.includes("nebula") || s.id.includes("listen")
          ? await canvasAnimating(page)
          : null;
      const metrics = {
        ...cpu,
        pssMb: pss.totalPssMb,
        pssKb: pss.totalPssKb,
        playing: await isPlaybackActive(page),
        canvas,
      };
      const check = checkThresholds(s.id, metrics);
      bench.push({
        id: s.id,
        ...metrics,
        withinThreshold: check.withinThreshold,
        violations: check.violations,
      });
      if (s.sampleInBg) adbWake(device);
    } catch (err) {
      bench.push({ id: s.id, error: String(err) });
      adbWake(device);
    }
  }
  return bench;
}

export async function runMatrix(opts) {
  const device = resolveDevice();
  clearLogcat(device);
  const pid = setupCdpForward(device, opts.cdpPort ?? 9222);
  const capture = { pageErrors: [], consoleErrors: [], consoleWarnings: [] };
  const { browser, page, base } = await connectCdp(opts.cdpPort ?? 9222);
  attachErrorCapture(page, capture);

  const outDir = opts.outDir ?? join("test-results", `mobile-qa-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  const matrixOpts = {
    device,
    pid,
    outDir,
    perfOnly: opts.perfOnly,
    alwaysPlay: opts.alwaysPlay !== false,
    perfSampleSec: opts.perfSampleSec ?? 8,
  };

  const report = {
    timestamp: new Date().toISOString(),
    device,
    pid,
    base,
    alwaysPlay: matrixOpts.alwaysPlay,
    capture,
    results: [],
    benchmark: [],
    summary: { total: 0, passed: 0, failed: 0 },
  };

  try {
    await waitForAppReady(page, base, 90000);
    if (/localhost|127\.0\.0\.1/i.test(base)) {
      throw new Error(
        `App non connessa al server LAN (base=${base}). Apri l'app e connetti al server prima del QA.`,
      );
    }

    if (matrixOpts.alwaysPlay) {
      await gotoPath(page, base, "/libreria");
      await page
        .waitForSelector(".library-page, .section-nav-tabs", { timeout: 30000 })
        .catch(() => {});
      await clickLibBrowse(page, "artists").catch(async () => {
        await gotoPath(page, base, "/");
        await ensurePlayback(page);
      });
      const started = await ensurePlayback(page);
      report.playbackStarted = started;
      if (!started) {
        report.playbackWarning = "Impossibile avviare playback iniziale";
      }
      await waitMs(2000);
    }

    if (opts.only === "studio") {
      report.results = await runStudioMatrix(page, base, capture, matrixOpts);
    } else if (opts.perf) {
      report.benchmark = await runPerfBenchmark(page, base, matrixOpts);
    } else {
      report.results.push(
        ...(await runCoreMatrix(page, base, capture, matrixOpts)),
      );
      report.results.push(
        ...(await runSecondaryMatrix(page, base, capture, matrixOpts)),
      );
      report.results.push(
        ...(await runPlayerStressMatrix(page, base, capture, matrixOpts)),
      );
      if (opts.withPerf) {
        report.benchmark = await runPerfBenchmark(page, base, matrixOpts);
      }
    }
  } finally {
    await pausePlayback(page).catch(() => {});
    await browser.close().catch(() => {});
  }

  report.summary.total = report.results.length;
  report.summary.passed = report.results.filter((r) => r.ok).length;
  report.summary.failed = report.summary.total - report.summary.passed;

  const outFile = join(outDir, "report.json");
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  report.outFile = outFile;
  return report;
}
