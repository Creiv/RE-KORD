import { spawnSync } from "child_process";
import {
  bundledBinAvailable,
  expectedBundledBinPath,
  resolveBundledBinPath,
} from "./bundledBin.mjs";

const DEFAULT_CLOUDFLARED_BIN =
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

function bundledFilename() {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function findExecutableOnPath(name) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [name], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  if (result.status !== 0) return null;
  return (
    String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

export function resolveCloudflaredPath() {
  const configured = String(process.env.REKORD_CLOUDFLARED_BIN || "").trim();
  if (configured) return configured;
  const bundled = resolveBundledBinPath(bundledFilename());
  if (bundled) return bundled;
  return findExecutableOnPath(DEFAULT_CLOUDFLARED_BIN) || DEFAULT_CLOUDFLARED_BIN;
}

export function isCloudflaredAvailable() {
  const configured = String(process.env.REKORD_CLOUDFLARED_BIN || "").trim();
  if (configured) {
    try {
      return spawnSync(configured, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
      }).status === 0;
    } catch {
      return false;
    }
  }
  if (bundledBinAvailable(bundledFilename())) return true;
  try {
    return (
      spawnSync(DEFAULT_CLOUDFLARED_BIN, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

export function expectedCloudflaredInstallPath() {
  return expectedBundledBinPath(bundledFilename());
}
