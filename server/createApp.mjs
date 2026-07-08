/**
 * Factory Express per server RE-KORD e test di integrazione.
 * @param {{ distPath?: string }} [opts]
 */
import express from "express";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

import { isLibraryRootConfigured } from "./musicRootConfig.mjs";
import { sendError, apiSkipsLibraryGate } from "./httpUtils.mjs";
import { hasReservedPathSegment, pathHasParentDirSegment } from "./pathSafety.mjs";
import { registerSystemRoutes } from "./routes/systemRoutes.mjs";
import { registerBackupRoutes } from "./routes/backupRoutes.mjs";
import { registerConfigRoutes } from "./routes/configRoutes.mjs";
import { registerLibraryRoutes } from "./routes/libraryRoutes.mjs";
import { registerCatalogRoutes } from "./routes/catalogRoutes.mjs";
import { registerUserStateRoutes } from "./routes/userStateRoutes.mjs";
import { registerDownloadRoutes } from "./routes/downloadRoutes.mjs";
import { registerFsRoutes } from "./routes/fsRoutes.mjs";
import { registerMetadataRoutes } from "./routes/metadataRoutes.mjs";
import { registerTranscodeRoutes } from "./transcode.mjs";
import { registerMediaRoutes } from "./mediaRoutes.mjs";
import { registerJobRoutes } from "./jobs/routes.mjs";
import { registerDiagnosticsRoutes } from "./routes/diagnosticsRoutes.mjs";
import { requestIdMiddleware, getLogger } from "./logger.mjs";
import { recordError } from "./errorBuffer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isLoopbackOriginHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * @param {{ distPath?: string }} [opts]
 * @returns {import('express').Express}
 */
export function createApp(opts = {}) {
  const app = express();
  const distPath = opts.distPath ?? path.join(__dirname, "..", "dist");

  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (!origin || origin === "null") {
      if (origin === "null") {
        return res
          .status(403)
          .json({ ok: false, data: null, error: "cross_origin_forbidden" });
      }
      return next();
    }
    let parsed = null;
    try {
      parsed = new URL(origin);
    } catch {
      return res
        .status(403)
        .json({ ok: false, data: null, error: "cross_origin_forbidden" });
    }
    const reqHost = String(req.headers.host || "");
    if (parsed.host === reqHost) return next();
    if (isLoopbackOriginHostname(parsed.hostname)) return next();
    return res
      .status(403)
      .json({ ok: false, data: null, error: "cross_origin_forbidden" });
  });
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", (req, res, next) => {
    if (apiSkipsLibraryGate(req)) return next();
    if (!isLibraryRootConfigured()) {
      return sendError(
        res,
        428,
        "Library folder not configured. Set it in server Settings.",
        { details: { code: "LIBRARY_REQUIRED" } },
      );
    }
    next();
  });

  app.use("/media", (req, res, next) => {
    const reqPath = req.path || "";
    if (pathHasParentDirSegment(reqPath) || hasReservedPathSegment(reqPath))
      return res.status(404).end();
    next();
  });

  registerTranscodeRoutes(app);
  registerMediaRoutes(app);
  registerSystemRoutes(app);
  registerBackupRoutes(app);
  registerConfigRoutes(app);
  registerLibraryRoutes(app);
  registerCatalogRoutes(app);
  registerUserStateRoutes(app);
  registerDownloadRoutes(app);
  registerFsRoutes(app);
  registerMetadataRoutes(app);
  registerJobRoutes(app);
  registerDiagnosticsRoutes(app);

  const distIndexPath = path.join(distPath, "index.html");
  if (existsSync(distIndexPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/media"))
        return next();
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (res.headersSent) return;
      res.sendFile("index.html", { root: distPath }, (error) => {
        if (!error) return;
        if (error.code === "ECONNABORTED" || error.code === "EPIPE") return;
        getLogger().error({ err: error }, "SPA fallback failed");
        if (!res.headersSent) {
          res
            .status(503)
            .type("text/plain")
            .send("RE-KORD UI unavailable. Run npm run build and restart the server.");
        }
      });
    });
  } else {
    app.use((req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/media"))
        return next();
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res
        .status(503)
        .type("text/plain")
        .send("RE-KORD UI not built. Run npm run build and restart the server.");
    });
  }

  app.use((error, req, res, _next) => {
    const requestId = req.requestId || null;
    recordError(error, `${req.method} ${req.path}`);
    getLogger().error({ err: error, requestId }, "Unhandled request error");
    return sendError(res, 500, "Internal server error", requestId ? { requestId } : null);
  });

  return app;
}
