/**
 * Shutdown graceful del server RE-KORD.
 */
import { stopRemoteAccess } from "./remoteAccess.mjs";
import { killActiveYtdlpDownloads } from "./ytdlpStudio.mjs";
import { stopAllLibraryWatchers } from "./scanner/watcher.mjs";
import { drainWriteChains } from "./rekordDataStore.mjs";
import { drainUserStateChains } from "./userState.mjs";
import { closeAllLibraryDbs } from "./db/index.mjs";
import { cancelAllJobs } from "./jobs/queue.mjs";
import { getLogger } from "./logger.mjs";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** @type {import('http').Server | null} */
let activeHttpServer = null;
let shuttingDown = false;

/**
 * @param {import('http').Server} server
 */
export function registerHttpServer(server) {
  activeHttpServer = server;
}

/**
 * @returns {Promise<void>}
 */
export async function gracefulShutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  const logger = getLogger();
  logger.info({ signal }, "Graceful shutdown started");

  const forceTimer = setTimeout(() => {
    logger.warn("Shutdown timeout reached, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  try {
    await stopRemoteAccess();
    killActiveYtdlpDownloads();
    cancelAllJobs();
    stopAllLibraryWatchers();

    await Promise.allSettled([drainWriteChains(), drainUserStateChains()]);

    if (activeHttpServer) {
      // Le connessioni keep-alive/SSE aperte impedirebbero a close() di
      // completare: vanno chiuse esplicitamente.
      activeHttpServer.closeIdleConnections?.();
      const closed = new Promise((resolve, reject) => {
        activeHttpServer.close((err) => (err ? reject(err) : resolve()));
      });
      const drainTimer = setTimeout(() => {
        activeHttpServer.closeAllConnections?.();
      }, 3000);
      drainTimer.unref?.();
      await closed;
      clearTimeout(drainTimer);
    }

    closeAllLibraryDbs();
    logger.info("Graceful shutdown complete");
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Graceful shutdown failed");
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

export function installShutdownHandlers() {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      void gracefulShutdown(sig);
    });
  }
}
