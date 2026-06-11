/**
 * Accesso remoto via tunnel Cloudflare quick (cloudflared).
 * Estratto da index.mjs (Fase 6). Stato condiviso: remoteAccessState.
 */
import path from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { PORT } from "./serverPort.mjs";
import {
  getCloudflareLoggedIn,
  getCloudflareTunnelEnabled,
  setCloudflareTunnelEnabled,
} from "./musicRootConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLOUDFLARED_BIN = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const CF_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

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

function resolveBundledCloudflaredPath() {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(__dirname, "bin", name);
}

function resolveCloudflaredPath() {
  const configured = String(process.env.REKORD_CLOUDFLARED_BIN || "").trim();
  if (configured) return configured;
  const bundled = resolveBundledCloudflaredPath();
  if (existsSync(bundled)) return bundled;
  return DEFAULT_CLOUDFLARED_BIN;
}

export function remoteSnapshot() {
  return {
    enabled: remoteAccessState.enabled,
    status: remoteAccessState.status,
    provider: remoteAccessState.provider,
    publicUrl: remoteAccessState.publicUrl,
    error: remoteAccessState.error,
    startedAt: remoteAccessState.startedAt,
    cloudflaredPath: remoteAccessState.cloudflaredPath,
    cloudflareLoggedIn: remoteAccessState.cloudflareLoggedIn,
  };
}

export function markRemoteError(err) {
  remoteAccessState.status = "error";
  const msg = String(err?.message || err || "cloudflared error");
  if (msg.includes("ENOENT")) {
    remoteAccessState.error =
      "Cloudflared non trovato. Reinstalla RE-KORD oppure configura REKORD_CLOUDFLARED_BIN.";
    return;
  }
  remoteAccessState.error = msg;
}

export function stopRemoteAccess() {
  remoteAccessState.enabled = false;
  void setCloudflareTunnelEnabled(false);
  remoteAccessState.status = "stopped";
  remoteAccessState.publicUrl = null;
  remoteAccessState.error = null;
  remoteAccessState.startedAt = null;
  if (cloudflaredChild && !cloudflaredChild.killed) {
    try {
      cloudflaredChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  cloudflaredChild = null;
}

export function startRemoteAccess() {
  if (cloudflaredChild && !cloudflaredChild.killed) return;
  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  if (!existsSync(distIndex)) {
    remoteAccessState.enabled = false;
    remoteAccessState.status = "error";
    remoteAccessState.error =
      "UI non compilata: esegui npm run build prima di avviare il tunnel.";
    remoteAccessState.publicUrl = null;
    return;
  }
  remoteAccessState.enabled = true;
  void setCloudflareTunnelEnabled(true);
  remoteAccessState.status = "starting";
  remoteAccessState.publicUrl = null;
  remoteAccessState.error = null;
  remoteAccessState.startedAt = new Date().toISOString();
  const cloudflaredPath = resolveCloudflaredPath();
  remoteAccessState.cloudflaredPath = cloudflaredPath;
  const target = `http://127.0.0.1:${PORT}`;
  const args = ["tunnel", "--url", target, "--no-autoupdate"];
  const child = spawn(cloudflaredPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  cloudflaredChild = child;
  const onLine = (line) => {
    const str = String(line || "");
    const match = str.match(CF_URL_REGEX);
    if (match?.[0]) {
      remoteAccessState.status = "running";
      remoteAccessState.publicUrl = match[0];
      remoteAccessState.error = null;
    }
  };
  child.stdout?.on("data", onLine);
  child.stderr?.on("data", onLine);
  child.on("error", (err) => {
    markRemoteError(err);
    cloudflaredChild = null;
  });
  child.on("exit", () => {
    if (remoteAccessState.enabled) {
      markRemoteError("Tunnel terminato");
    } else {
      remoteAccessState.status = "stopped";
    }
    cloudflaredChild = null;
  });
}
