/**
 * Accesso remoto via tunnel Cloudflare quick (cloudflared).
 * Estratto da index.mjs (Fase 6). Stato condiviso: remoteAccessState.
 */
import path from "path";
import dns from "node:dns/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { PORT } from "./serverPort.mjs";
import { getLogger } from "./logger.mjs";
import {
  isCloudflaredAvailable,
  resolveCloudflaredPath,
  expectedCloudflaredInstallPath,
} from "./cloudflaredBin.mjs";
import { pathLooksLikeAsarArchive } from "./bundledBin.mjs";

import {
  getCloudflareLoggedIn,
  getCloudflareTunnelEnabled,
  getListenHost,
  setCloudflareTunnelEnabled,
} from "./musicRootConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_START_TIMEOUT_MS = 90_000;
const TUNNEL_REACHABILITY_TIMEOUT_MS = 90_000;
const TUNNEL_REACHABILITY_INTERVAL_MS = 2_000;
const TUNNEL_FETCH_TIMEOUT_MS = 8_000;
const TUNNEL_LOCAL_FETCH_TIMEOUT_MS = 5_000;
const OUTPUT_BUFFER_MAX = 64 * 1024;

export const remoteAccessState = {
  enabled: getCloudflareTunnelEnabled(),
  status: "stopped",
  provider: "cloudflare-quick",
  publicUrl: null,
  error: null,
  startedAt: null,
  cloudflaredPath: null,
  cloudflareLoggedIn: getCloudflareLoggedIn(),
};
let cloudflaredChild = null;
let startTimeoutHandle = null;
let reachabilityGeneration = 0;
let pendingTunnelUrl = null;

export function isTryCloudflareHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return host === "trycloudflare.com" || host.endsWith(".trycloudflare.com");
}

/** Normalizza URL client: i tunnel quick Cloudflare accettano solo HTTPS. */
export function normalizeRemoteClientBaseUrl(input) {
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (isTryCloudflareHost(parsed.hostname)) {
      parsed.protocol = "https:";
      parsed.port = "";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Host locale verso cui cloudflared inoltra (allineato a getListenHost). */
export function resolveCloudflaredTarget() {
  const listenHost = getListenHost();
  const host =
    listenHost === "0.0.0.0" || !listenHost ? "127.0.0.1" : listenHost;
  return `http://${host}:${PORT}`;
}

async function fetchHealthOk(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  if (res.ok) return true;
  throw new Error(`HTTP ${res.status}`);
}

/**
 * Cloudflared stampa l'URL prima che il tunnel sia raggiungibile dall'esterno.
 * Verifichiamo /api/health via HTTPS; se il loopback verso l'URL pubblico fallisce
 * (hairpin NAT, proxy, DNS lento) accettiamo DNS risolto + backend locale ok.
 */
export async function waitForTunnelReachable(
  publicUrl,
  {
    timeoutMs = TUNNEL_REACHABILITY_TIMEOUT_MS,
    intervalMs = TUNNEL_REACHABILITY_INTERVAL_MS,
    fetchImpl = globalThis.fetch,
    dnsLookupImpl = (hostname) => dns.lookup(hostname),
    localHealthUrl = `${resolveCloudflaredTarget()}/api/health`,
    isAlive = () => Boolean(cloudflaredChild && !cloudflaredChild.killed),
  } = {},
) {
  const base = normalizeRemoteClientBaseUrl(publicUrl);
  if (!base) throw new Error("URL tunnel Cloudflare non valido");
  const hostname = new URL(base).hostname;
  const publicHealthUrl = `${base}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let dnsReady = false;
  let localReady = false;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error("Tunnel terminato durante la verifica");
    }
    if (!dnsReady) {
      try {
        await dnsLookupImpl(hostname);
        dnsReady = true;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!localReady) {
      try {
        await fetchHealthOk(
          fetchImpl,
          localHealthUrl,
          TUNNEL_LOCAL_FETCH_TIMEOUT_MS,
        );
        localReady = true;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    try {
      await fetchHealthOk(fetchImpl, publicHealthUrl, TUNNEL_FETCH_TIMEOUT_MS);
      return base;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (dnsReady && localReady) return base;
    }
    await sleep(intervalMs);
  }
  throw lastErr || new Error("Tunnel URL non raggiungibile");
}

/** Estrae l'URL trycloudflare da output cloudflared (anche se spezzato su più chunk). */
export function extractCloudflareTunnelUrl(buffer) {
  const text = String(buffer || "");
  const match = text.match(CF_URL_REGEX);
  return match?.[0] ?? null;
}

function createOutputCollector(onUrl) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk || "");
    if (buffer.length > OUTPUT_BUFFER_MAX) {
      buffer = buffer.slice(-OUTPUT_BUFFER_MAX);
    }
    const url = extractCloudflareTunnelUrl(buffer);
    if (url) onUrl(url);
  };
}

function clearStartTimeout() {
  if (startTimeoutHandle != null) {
    clearTimeout(startTimeoutHandle);
    startTimeoutHandle = null;
  }
}

function clearRemoteTimeouts() {
  clearStartTimeout();
}

function killCloudflaredChild() {
  if (cloudflaredChild && !cloudflaredChild.killed) {
    try {
      cloudflaredChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  cloudflaredChild = null;
}

export function remoteSnapshot() {
  const active = remoteAccessState.status === "running";
  return {
    enabled: remoteAccessState.enabled,
    status: remoteAccessState.status,
    provider: remoteAccessState.provider,
    publicUrl: active ? remoteAccessState.publicUrl : null,
    error: remoteAccessState.error,
    startedAt: remoteAccessState.startedAt,
    cloudflaredPath: remoteAccessState.cloudflaredPath,
    cloudflareLoggedIn: remoteAccessState.cloudflareLoggedIn,
  };
}

export function markRemoteError(err) {
  clearRemoteTimeouts();
  remoteAccessState.enabled = false;
  void setCloudflareTunnelEnabled(false);
  remoteAccessState.status = "error";
  remoteAccessState.publicUrl = null;
  const msg = String(err?.message || err || "cloudflared error");
  if (msg.includes("ENOTDIR") || pathLooksLikeAsarArchive(remoteAccessState.cloudflaredPath)) {
    remoteAccessState.error =
      "Cloudflared non eseguibile dal pacchetto. Reinstalla RE-KORD Server oppure imposta REKORD_CLOUDFLARED_BIN.";
    return;
  }
  if (msg.includes("ENOENT")) {
    remoteAccessState.error =
      "Cloudflared non trovato. Reinstalla RE-KORD oppure configura REKORD_CLOUDFLARED_BIN.";
    return;
  }
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    /no address associated with hostname/i.test(msg)
  ) {
    remoteAccessState.error =
      "DNS del tunnel Cloudflare non risolvibile. Controlla internet sul server, ferma e riavvia la condivisione, poi usa il nuovo URL/QR.";
    return;
  }
  if (/Tunnel URL non raggiungibile|Tunnel terminato durante la verifica/i.test(msg)) {
    remoteAccessState.error =
      "Il tunnel Cloudflare non è ancora raggiungibile. Ferma e riavvia la condivisione, poi attendi qualche secondo prima di connetterti.";
    return;
  }
  remoteAccessState.error = msg;
}

export async function stopRemoteAccess() {
  clearRemoteTimeouts();
  reachabilityGeneration += 1;
  pendingTunnelUrl = null;
  remoteAccessState.enabled = false;
  remoteAccessState.status = "stopped";
  remoteAccessState.publicUrl = null;
  remoteAccessState.error = null;
  remoteAccessState.startedAt = null;
  killCloudflaredChild();
  await setCloudflareTunnelEnabled(false);
}

export function startRemoteAccess() {
  if (cloudflaredChild && !cloudflaredChild.killed) return;
  const logger = getLogger();
  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  if (!existsSync(distIndex)) {
    remoteAccessState.enabled = false;
    remoteAccessState.status = "error";
    remoteAccessState.error =
      "UI non compilata: esegui npm run build prima di avviare il tunnel.";
    remoteAccessState.publicUrl = null;
    return;
  }
  clearRemoteTimeouts();
  pendingTunnelUrl = null;
  remoteAccessState.enabled = true;
  void setCloudflareTunnelEnabled(true);
  remoteAccessState.status = "starting";
  remoteAccessState.publicUrl = null;
  remoteAccessState.error = null;
  remoteAccessState.startedAt = new Date().toISOString();
  const cloudflaredPath = resolveCloudflaredPath();
  remoteAccessState.cloudflaredPath = cloudflaredPath;
  if (!isCloudflaredAvailable()) {
    remoteAccessState.enabled = false;
    remoteAccessState.status = "error";
    remoteAccessState.error = `Cloudflared non trovato (atteso in ${expectedCloudflaredInstallPath()}). Reinstalla RE-KORD Server.`;
    remoteAccessState.publicUrl = null;
    return;
  }
  const target = resolveCloudflaredTarget();
  const args = ["tunnel", "--url", target, "--no-autoupdate"];
  logger.info({ cloudflaredPath, target }, "Avvio tunnel Cloudflare quick");
  const child = spawn(cloudflaredPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  cloudflaredChild = child;
  const onUrl = (url) => {
    const normalized = normalizeRemoteClientBaseUrl(url);
    if (!normalized || pendingTunnelUrl === normalized) return;
    if (remoteAccessState.status !== "starting") return;
    pendingTunnelUrl = normalized;
    clearStartTimeout();
    remoteAccessState.status = "running";
    remoteAccessState.publicUrl = normalized;
    remoteAccessState.error = null;
    logger.info({ publicUrl: normalized }, "Tunnel Cloudflare URL disponibile");
    const generation = ++reachabilityGeneration;
    void (async () => {
      try {
        await waitForTunnelReachable(normalized, {
          timeoutMs: TUNNEL_REACHABILITY_TIMEOUT_MS,
        });
        if (generation !== reachabilityGeneration) return;
        if (remoteAccessState.status !== "running") return;
        remoteAccessState.error = null;
        logger.info({ publicUrl: normalized }, "Tunnel Cloudflare verificato");
      } catch (err) {
        if (generation !== reachabilityGeneration) return;
        if (remoteAccessState.status !== "running") return;
        logger.warn({ err, publicUrl: normalized }, "Verifica tunnel Cloudflare non riuscita");
        remoteAccessState.error =
          "Il tunnel potrebbe non essere ancora raggiungibile dall'esterno. Attendi qualche secondo e riprova la connessione.";
      }
    })();
  };
  const collectOutput = createOutputCollector(onUrl);
  child.stdout?.on("data", collectOutput);
  child.stderr?.on("data", collectOutput);
  startTimeoutHandle = setTimeout(() => {
    if (remoteAccessState.status !== "starting") return;
    markRemoteError(
      "Timeout avvio tunnel: cloudflared non ha restituito un URL pubblico.",
    );
    killCloudflaredChild();
  }, TUNNEL_START_TIMEOUT_MS);
  startTimeoutHandle.unref?.();
  child.on("error", (err) => {
    logger.warn({ err }, "cloudflared spawn error");
    markRemoteError(err);
    cloudflaredChild = null;
  });
  child.on("exit", (code, signal) => {
    clearRemoteTimeouts();
    if (!remoteAccessState.enabled) {
      remoteAccessState.status = "stopped";
      remoteAccessState.publicUrl = null;
    } else if (remoteAccessState.status !== "running") {
      logger.warn({ code, signal }, "cloudflared terminato prima dell'URL pubblico");
      markRemoteError("Tunnel terminato prima di essere pronto");
    } else {
      logger.warn({ code, signal }, "cloudflared terminato");
      markRemoteError("Tunnel terminato");
    }
    cloudflaredChild = null;
  });
}
