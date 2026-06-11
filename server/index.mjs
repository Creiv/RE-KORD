import express from "express";
import path from "path";

import { existsSync } from "fs";
import { fileURLToPath } from "url";

import {
  getListenHost,
  getMusicRoot,
  isLibraryRootConfigured,
  waitForInitialLayoutMigration,
} from "./musicRootConfig.mjs";

import { buildLanAccessUrls } from "./lanNetwork.mjs";

import { PORT } from "./serverPort.mjs";
import {
  remoteAccessState,
  markRemoteError,
  startRemoteAccess,
  stopRemoteAccess,
} from "./remoteAccess.mjs";

import { sendError, apiSkipsLibraryGate } from "./httpUtils.mjs";
import { hasReservedPathSegment, pathHasParentDirSegment } from "./pathSafety.mjs";
import { getLibraryIndex } from "./libraryIndexService.mjs";
import { registerSystemRoutes } from "./routes/systemRoutes.mjs";
import { registerBackupRoutes } from "./routes/backupRoutes.mjs";
import { registerConfigRoutes } from "./routes/configRoutes.mjs";
import { registerLibraryRoutes } from "./routes/libraryRoutes.mjs";
import { registerCatalogRoutes } from "./routes/catalogRoutes.mjs";
import { registerUserStateRoutes } from "./routes/userStateRoutes.mjs";
import { registerDownloadRoutes } from "./routes/downloadRoutes.mjs";
import { registerFsRoutes } from "./routes/fsRoutes.mjs";
import { registerMetadataRoutes } from "./routes/metadataRoutes.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

/**
 * Blocco richieste cross-site dei browser (niente più CORS aperto).
 * Permesse: richieste senza Origin (navigazione, curl, Electron main,
 * tag media), stessa origin della richiesta, e origin loopback
 * (dev Vite :5173 con proxy che riscrive Host, app Electron).
 */
function isLoopbackOriginHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
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
      { details: { code: "LIBRARY_REQUIRED" } }
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

app.use("/media", (req, res, next) => {
  if (!isLibraryRootConfigured()) return res.status(503).end();
  const root = getMusicRoot();
  if (!root) return res.status(503).end();
  express.static(root, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".flac"))
        res.setHeader("Content-Type", "audio/flac");
      else if (filePath.endsWith(".m4a"))
        res.setHeader("Content-Type", "audio/mp4");
      else if (filePath.endsWith(".webm"))
        res.setHeader("Content-Type", "audio/webm");
    },
  })(req, res, next);
});

registerSystemRoutes(app);
registerBackupRoutes(app);
registerConfigRoutes(app);
registerLibraryRoutes(app);
registerCatalogRoutes(app);
registerUserStateRoutes(app);
registerDownloadRoutes(app);
registerFsRoutes(app);
registerMetadataRoutes(app);

const distPath = path.join(__dirname, "..", "dist");
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
      console.error("[rekord] SPA fallback failed:", error?.message || error);
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

app.use((error, _req, res, _next) => {
  console.error(error);
  return sendError(res, 500, "Internal server error");
});

async function startListening() {
  await waitForInitialLayoutMigration();

  if (process.env.REKORD_DOCKER === "1" && isLibraryRootConfigured()) {
    const root = getMusicRoot();
    void getLibraryIndex(root).catch((err) => {
      console.warn(
        "[music-server] docker library warmup:",
        err?.message ?? err,
      );
    });
  }

  const LISTEN_HOST = getListenHost();
  const httpServer = app.listen(PORT, LISTEN_HOST, () => {
    const rootLabel = isLibraryRootConfigured()
      ? getMusicRoot()
      : "(library not configured)";
    console.log(
      `[music-server] http://${LISTEN_HOST}:${PORT} -> ${rootLabel}`,
    );
    const lanUrls = buildLanAccessUrls(PORT);
    if (lanUrls.length) {
      console.log(`[music-server] LAN: ${lanUrls.join(", ")}`);
    }
    if (process.platform === "win32" && LISTEN_HOST === "0.0.0.0") {
      console.log(
        "[music-server] Windows: se l'URL Cloudflare funziona ma l'IP LAN no, consenti RE-KORD sul firewall per reti private.",
      );
    }
    if (remoteAccessState.enabled) {
      try {
        startRemoteAccess();
      } catch (error) {
        markRemoteError(error);
      }
    }
  });
  httpServer.on("error", (err) => {
    console.error("[music-server] listen", err);
    process.exit(1);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopRemoteAccess();
    process.exit(0);
  });
}

startListening().catch((err) => {
  console.error("[music-server] startup", err);
  process.exit(1);
});
