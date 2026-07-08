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
} from "./remoteAccess.mjs";
import { getLibraryIndex } from "./libraryIndexService.mjs";
import { createApp } from "./createApp.mjs";
import { registerHttpServer, installShutdownHandlers } from "./shutdown.mjs";
import { getLogger } from "./logger.mjs";
import { bootstrapProviders } from "./providers/index.mjs";

bootstrapProviders();
const app = createApp();

async function startListening() {
  await waitForInitialLayoutMigration();
  const logger = getLogger();

  if (process.env.REKORD_DOCKER === "1" && isLibraryRootConfigured()) {
    const root = getMusicRoot();
    void getLibraryIndex(root).catch((err) => {
      logger.warn({ err }, "Docker library warmup failed");
    });
  }

  const LISTEN_HOST = getListenHost();
  const httpServer = app.listen(PORT, LISTEN_HOST, () => {
    const rootLabel = isLibraryRootConfigured()
      ? getMusicRoot()
      : "(library not configured)";
    logger.info(
      { host: LISTEN_HOST, port: PORT, musicRoot: rootLabel },
      "RE-KORD server listening",
    );
    const lanUrls = buildLanAccessUrls(PORT);
    if (lanUrls.length) {
      logger.info({ lanUrls }, "LAN access URLs");
    }
    if (process.platform === "win32" && LISTEN_HOST === "0.0.0.0") {
      logger.info("Windows: allow RE-KORD through firewall for private networks if LAN fails");
    }
    if (remoteAccessState.enabled) {
      try {
        startRemoteAccess();
      } catch (error) {
        markRemoteError(error);
      }
    }
  });
  registerHttpServer(httpServer);
  httpServer.on("error", (err) => {
    logger.error({ err }, "Server listen error");
    process.exit(1);
  });
}

installShutdownHandlers();

startListening().catch((err) => {
  getLogger().error({ err }, "Server startup failed");
  process.exit(1);
});

export { app, createApp };
