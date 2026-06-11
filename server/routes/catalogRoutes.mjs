/**
 * Catalogo e anteprime web (discover, tracks, preview/stream).
 * Estratto da index.mjs (Fase 6).
 */
import {
  buildCatalogWebPreviewYtdlpArgs,
  createCatalogWebPreviewPlayToken,
  fetchCatalogWebReleaseTracks,
  getPreviewStreamForToken,
  normalizeCatalogWebUrl,
} from "../catalogWebPreview.mjs";
import { sendError, sendOk } from "../httpUtils.mjs";
import { getLibraryIndexCacheEpochSnapshot } from "../libraryIndexCache.mjs";
import { getLibraryIndex } from "../libraryIndexService.mjs";
import { buildCatalogFromIndex } from "../librarySelection.mjs";
import { getMusicRoot } from "../musicRootConfig.mjs";
import { fetchCatalogWebDiscover } from "../youtubeMusicDiscover.mjs";
import { resolveYtdlpPath } from "../ytdlpPath.mjs";
import {
  forceKillStudioYtdlp,
  releaseEnrichConfig,
  winHideExec,
  ytdlpCookieArgs,
  ytdlpJavascriptArgs,
} from "../ytdlpStudio.mjs";
import { spawn } from "child_process";

export function registerCatalogRoutes(app) {
  app.get("/api/catalog", async (req, res) => {
    try {
      const root = getMusicRoot();
      const index = await getLibraryIndex(root);
      const summary = String(req.query.summary || "") === "1";
      const artistId = String(req.query.artistId || "").trim();
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, buildCatalogFromIndex(index, { summary, artistId }));
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  const CATALOG_WEB_DISCOVER_CACHE_TTL_MS = 8 * 60 * 1000;
  /** @type {{ at: number, epoch: number, payload: object } | null} */
  let catalogWebDiscoverCache = null;

  app.get("/api/catalog-web-discover", async (req, res) => {
    try {
      const root = getMusicRoot();
      const force = String(req.query.force ?? "") === "1";
      const epoch = getLibraryIndexCacheEpochSnapshot(root);
      const now = Date.now();
      if (
        !force &&
        catalogWebDiscoverCache &&
        catalogWebDiscoverCache.epoch === epoch &&
        now - catalogWebDiscoverCache.at < CATALOG_WEB_DISCOVER_CACHE_TTL_MS
      ) {
        res.set("Cache-Control", "no-store, must-revalidate");
        return sendOk(res, catalogWebDiscoverCache.payload);
      }
      const index = await getLibraryIndex(root);
      const payload = await fetchCatalogWebDiscover(index);
      if (payload.error) {
        return sendError(res, 502, payload.error);
      }
      catalogWebDiscoverCache = {
        at: now,
        epoch,
        payload,
      };
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, payload);
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/catalog-web-tracks", async (req, res) => {
    const pageUrl = normalizeCatalogWebUrl(String(req.query.url ?? ""));
    if (!pageUrl) return sendError(res, 400, "Provide a valid YouTube Music URL");
    try {
      const ytdlpOff = process.env.ENABLE_YTDLP === "0";
      const program = ytdlpOff ? null : resolveYtdlpPath();
      const { timeoutMs } = releaseEnrichConfig();
      const payload = await fetchCatalogWebReleaseTracks({
        pageUrl,
        ytdlpProgram: program,
        ytdlpExtraArgs: () => [
          ...ytdlpJavascriptArgs(),
          ...ytdlpCookieArgs(),
        ],
        timeoutMs: Math.max(timeoutMs, 25_000),
      });
      return sendOk(res, {
        tracks: payload.tracks,
        title: payload.title || null,
        error: payload.error,
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/catalog-web-preview/play", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0") {
      return sendError(res, 403, "Preview disabled (ENABLE_YTDLP=0)");
    }
    const watchUrl = normalizeCatalogWebUrl(String(req.query.url ?? ""));
    if (!watchUrl) return sendError(res, 400, "Provide a valid YouTube Music URL");
    let built;
    try {
      built = buildCatalogWebPreviewYtdlpArgs(watchUrl, () => [
        ...ytdlpJavascriptArgs(),
        ...ytdlpCookieArgs(),
      ]);
    } catch (error) {
      return sendError(res, 400, String(error?.message || error));
    }
    const program = resolveYtdlpPath();
    try {
      req.socket?.setNoDelay?.(true);
    } catch {
      /* ignore */
    }

    const stderrAcc = { buffer: "", totalChars: 0 };
    let bytesOut = 0;
    let streamStarted = false;
    const child = spawn(program, built.args, {
      env: { ...process.env, FORCE_COLOR: "0" },
      ...winHideExec(),
    });
    const killChild = () => forceKillStudioYtdlp(child);
    const onClientGone = () => killChild();
    req.on("aborted", onClientGone);
    res.on("close", onClientGone);
    const removeListeners = () => {
      req.removeListener("aborted", onClientGone);
      res.removeListener("close", onClientGone);
    };
    const previewMaxMs = 31_000;
    let previewCapTimer = null;
    const beginStream = () => {
      if (streamStarted) return;
      streamStarted = true;
      res.status(200);
      res.setHeader("Content-Type", built.contentType);
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("Accept-Ranges", "none");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Connection", "close");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      previewCapTimer = setTimeout(() => {
        killChild();
        if (!res.writableEnded) res.end();
      }, previewMaxMs);
    };
    child.stderr?.on("data", (chunk) => {
      const s = String(chunk);
      stderrAcc.buffer += s;
      stderrAcc.totalChars += s.length;
      if (stderrAcc.totalChars > 24_000) {
        stderrAcc.buffer = stderrAcc.buffer.slice(-12_000);
      }
    });
    child.stdout?.on("data", (chunk) => {
      bytesOut += chunk?.length ?? 0;
      beginStream();
      res.write(chunk);
    });
    child.on("error", (err) => {
      removeListeners();
      if (!res.headersSent) {
        return sendError(res, 502, String(err?.message || err));
      }
      if (!res.writableEnded) res.destroy();
    });
    child.on("close", (code) => {
      removeListeners();
      if (previewCapTimer) clearTimeout(previewCapTimer);
      if (code !== 0 && bytesOut === 0 && !res.headersSent) {
        const detail = stderrAcc.buffer.trim().slice(-600) || `yt-dlp exit ${code}`;
        return sendError(res, 422, detail);
      }
      if (!res.writableEnded) res.end();
    });
  });

  app.get("/api/catalog-web-preview", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0") {
      return sendError(res, 403, "Preview disabled (ENABLE_YTDLP=0)");
    }
    const watchUrl = normalizeCatalogWebUrl(String(req.query.url ?? ""));
    if (!watchUrl) return sendError(res, 400, "Provide a valid YouTube Music URL");
    try {
      const program = resolveYtdlpPath();
      const { timeoutMs } = releaseEnrichConfig();
      const token = await createCatalogWebPreviewPlayToken({
        watchUrl,
        ytdlpProgram: program,
        ytdlpExtraArgs: () => [
          ...ytdlpJavascriptArgs(),
          ...ytdlpCookieArgs(),
        ],
        timeoutMs: Math.max(timeoutMs, 30_000),
      });
      return sendOk(res, {
        playUrl: `/api/catalog-web-preview/stream?t=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      console.error(error);
      return sendError(res, 422, String(error?.message || error));
    }
  });

  app.get("/api/catalog-web-preview/stream", async (req, res) => {
    const token = String(req.query.t ?? "").trim();
    const streamUrl = getPreviewStreamForToken(token);
    if (!streamUrl) return sendError(res, 410, "Preview expired or invalid");
    try {
      let range = req.headers.range;
      const headers = /** @type {Record<string, string>} */ ({});
      if (range) {
        headers.Range = String(range);
      } else {
        const maxChunk = Number.parseInt(
          String(process.env.REKORD_PREVIEW_INITIAL_RANGE_BYTES ?? "524288"),
          10,
        );
        if (Number.isFinite(maxChunk) && maxChunk > 0) {
          headers.Range = `bytes=0-${maxChunk - 1}`;
        }
      }
      const upstream = await fetch(streamUrl, { headers, redirect: "follow" });
      res.status(upstream.status);
      for (const h of [
        "content-type",
        "content-length",
        "accept-ranges",
        "content-range",
      ]) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader("Cache-Control", "no-store, no-transform");
      if (!upstream.ok || !upstream.body) {
        res.end();
        return;
      }
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        return sendError(res, 502, String(error?.message || error));
      }
      res.end();
    }
  });

}
