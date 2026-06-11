/**
 * Config server, accesso remoto (tunnel), cookie YouTube, account.
 * Estratto da index.mjs (Fase 6).
 */
import multer from "multer";
import path from "path";
import { actLog, sendError, sendOk } from "../httpUtils.mjs";
import {
  clearPersistedYoutubeCookiesFile,
  createAccount,
  deleteAccount,
  findAccountById,
  getAccountsSnapshot,
  getConfigSnapshot,
  getMusicRoot,
  isLibraryRootConfigured,
  setCloudflareLoggedIn,
  setPersistedMusicRoot,
  setPersistedYoutubeCookiesFile,
  updateAccount,
} from "../musicRootConfig.mjs";
import {
  markRemoteError,
  remoteAccessState,
  remoteSnapshot,
  startRemoteAccess,
  stopRemoteAccess,
} from "../remoteAccess.mjs";
import {
  isCloudflareTunnelRequest,
  isServerAdminRequest,
} from "../requestAccess.mjs";

const uploadYoutubeCookies = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

/**
 * In Docker le interfacce del container (es. 172.21.0.2) non sono
 * raggiungibili dalla LAN: come hint usa l'host della richiesta corrente.
 */
function dockerLanAccessUrlFromReq(req) {
  const hostHdr = String(req.headers.host || "").trim();
  if (!hostHdr) return null;
  const hostname = hostHdr.replace(/:\d+$/, "");
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  ) {
    return null;
  }
  return `http://${hostHdr}`;
}

function buildConfigPayload(req) {
  const admin = isServerAdminRequest(req);
  const snap = getConfigSnapshot(admin);
  snap.localAccess = admin;
  // Accesso via tunnel Cloudflare: stessa vista dei client LAN, ma la UI
  // mostra in più lo stato dei cookie YouTube in sola lettura.
  snap.remoteTunnelAccess = isCloudflareTunnelRequest(req);
  if (process.env.REKORD_DOCKER === "1") {
    const url = dockerLanAccessUrlFromReq(req);
    snap.lanAccessUrl = url;
    snap.lanAccessUrls = url ? [url] : [];
  }
  snap.libraryRootWritable = Boolean(admin && !snap.lockedByEnv);
  snap.youtubeCookiesWritable = Boolean(admin && !snap.youtubeCookiesLockedByEnv);
  if (!admin && isLibraryRootConfigured()) {
    const root = getMusicRoot();
    if (root)
      snap.libraryRootLabel = path.basename(path.resolve(String(root)));
  }
  snap.remoteAccess = remoteSnapshot();
  return snap;
}

export function registerConfigRoutes(app) {
  app.get("/api/config", (req, res) => {
    return sendOk(res, buildConfigPayload(req));
  });

  app.get("/api/remote-access", (req, res) => {
    return sendOk(res, remoteSnapshot());
  });

  app.post("/api/remote-access/login", (req, res) => {
    if (!isServerAdminRequest(req)) {
      return sendError(res, 403, "Remote access settings are local-only.");
    }
    const url = "https://dash.cloudflare.com/";
    setCloudflareLoggedIn(true)
      .then((ok) => {
        remoteAccessState.cloudflareLoggedIn = ok;
        return sendOk(res, {
          loginUrl: url,
          note: "Apri Cloudflare Dashboard e completa il login.",
        });
      })
      .catch((error) => sendError(res, 500, String(error?.message || error)));
  });

  app.post("/api/remote-access/logout", (req, res) => {
    if (!isServerAdminRequest(req)) {
      return sendError(res, 403, "Remote access settings are local-only.");
    }
    setCloudflareLoggedIn(false)
      .then((ok) => {
        remoteAccessState.cloudflareLoggedIn = ok;
        return sendOk(res, remoteSnapshot());
      })
      .catch((error) => sendError(res, 500, String(error?.message || error)));
  });

  app.post("/api/remote-access/start", (req, res) => {
    if (!isServerAdminRequest(req)) {
      return sendError(res, 403, "Remote access settings are local-only.");
    }
    if (remoteAccessState.status === "running" || remoteAccessState.status === "starting") {
      return sendOk(res, remoteSnapshot());
    }
    try {
      startRemoteAccess();
      void actLog(req, {
        kind: "server",
        action: "remote-access",
        folder: null,
        detail: "start",
      });
      return sendOk(res, remoteSnapshot());
    } catch (error) {
      markRemoteError(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/remote-access/stop", (req, res) => {
    if (!isServerAdminRequest(req)) {
      return sendError(res, 403, "Remote access settings are local-only.");
    }
    stopRemoteAccess();
    void actLog(req, {
      kind: "server",
      action: "remote-access",
      folder: null,
      detail: "stop",
    });
    return sendOk(res, remoteSnapshot());
  });

  app.put("/api/config", async (req, res) => {
    try {
      const body = req.body || {};
      let did = false;
      if (body.musicRoot != null) {
        if (!isServerAdminRequest(req)) {
          return sendError(
            res,
            403,
            "Library folder can only be set from the machine running the server (local access).",
            { details: { code: "LIBRARY_ROOT_REMOTE_FORBIDDEN" } },
          );
        }
        const next = String(body.musicRoot).trim();
        if (!next) {
          return sendError(
            res,
            400,
            "Provide the absolute path to your music folder"
          );
        }
        await setPersistedMusicRoot(next);
        void actLog(req, {
          kind: "server",
          action: "config",
          folder: next,
          detail: "musicRoot",
        });
        did = true;
      }
      if (!did) {
        return sendError(res, 400, "No valid config fields in request body");
      }
      return sendOk(res, buildConfigPayload(req));
    } catch (error) {
      if (error?.code === "ENV_LOCKED") return sendError(res, 403, error.message);
      return sendError(res, 400, String(error?.message || error));
    }
  });

  app.post(
    "/api/config/youtube-cookies",
    uploadYoutubeCookies.single("file"),
    async (req, res) => {
      try {
        if (!isServerAdminRequest(req)) {
          return sendError(
            res,
            403,
            "YouTube cookies can only be configured from the machine running the server.",
            { details: { code: "YOUTUBE_COOKIES_REMOTE_FORBIDDEN" } },
          );
        }
        if (!req.file?.buffer?.length) {
          return sendError(res, 400, "Missing or empty cookie file");
        }
        await setPersistedYoutubeCookiesFile(req.file.buffer);
        void actLog(req, {
          kind: "server",
          action: "config",
          folder: null,
          detail: "youtubeCookies",
        });
        return sendOk(res, buildConfigPayload(req));
      } catch (error) {
        if (error?.code === "ENV_LOCKED") {
          return sendError(res, 403, String(error.message || error));
        }
        return sendError(res, 500, String(error?.message || error));
      }
    },
  );

  app.delete("/api/config/youtube-cookies", async (req, res) => {
    try {
      if (!isServerAdminRequest(req)) {
        return sendError(
          res,
          403,
          "YouTube cookies can only be configured from the machine running the server.",
          { details: { code: "YOUTUBE_COOKIES_REMOTE_FORBIDDEN" } },
        );
      }
      await clearPersistedYoutubeCookiesFile();
      void actLog(req, {
        kind: "server",
        action: "config",
        folder: null,
        detail: "youtubeCookies:clear",
      });
      return sendOk(res, buildConfigPayload(req));
    } catch (error) {
      if (error?.code === "ENV_LOCKED") {
        return sendError(res, 403, String(error.message || error));
      }
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/accounts", (_req, res) => {
    return sendOk(res, getAccountsSnapshot());
  });

  app.post("/api/accounts", async (req, res) => {
    try {
      const body = req.body || {};
      const created = await createAccount({
        name: body.name,
      });
      const newAcc = created.accounts.find(
        (a) => a.id === created.createdAccountId
      );
      void actLog(req, {
        kind: "server",
        action: "account_create",
        folder: null,
        detail: newAcc
          ? `${newAcc.name} (${newAcc.id})`
          : created.createdAccountId,
      });
      return sendOk(res, created, 201);
    } catch (error) {
      if (error?.code === "LIBRARY_NOT_CONFIGURED")
        return sendError(res, 400, error.message);
      if (error?.code === "ENV_LOCKED") return sendError(res, 403, error.message);
      return sendError(res, 400, String(error?.message || error));
    }
  });

  app.put("/api/accounts/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const before = findAccountById(id);
      const patch = req.body || {};
      const next = await updateAccount(id, patch);
      const parts = [];
      if (patch.name != null && before && String(patch.name) !== before.name) {
        parts.push("name");
      }
      void actLog(req, {
        kind: "server",
        action: "account_update",
        folder: null,
        detail: `${id}: ${parts.length ? parts.join(",") : "account"}`,
      });
      return sendOk(res, next);
    } catch (error) {
      if (error?.code === "LIBRARY_NOT_CONFIGURED")
        return sendError(res, 400, error.message);
      if (error?.code === "ENV_LOCKED") return sendError(res, 403, error.message);
      if (error?.code === "ACCOUNT_NOT_FOUND")
        return sendError(res, 404, error.message);
      return sendError(res, 400, String(error?.message || error));
    }
  });

  app.delete("/api/accounts/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const before = findAccountById(id);
      const snap = await deleteAccount(id);
      void actLog(req, {
        kind: "server",
        action: "account_delete",
        folder: null,
        detail: before ? `${before.name} (${id})` : id,
      });
      return sendOk(res, snap);
    } catch (error) {
      if (error?.code === "LIBRARY_NOT_CONFIGURED")
        return sendError(res, 400, error.message);
      if (error?.code === "ACCOUNT_NOT_FOUND")
        return sendError(res, 404, error.message);
      if (error?.code === "LAST_ACCOUNT")
        return sendError(res, 400, error.message);
      if (error?.code === "DEFAULT_ACCOUNT_LOCKED")
        return sendError(res, 400, error.message);
      return sendError(res, 400, String(error?.message || error));
    }
  });
}
