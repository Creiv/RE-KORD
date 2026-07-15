import { execSync } from "node:child_process";

export const PKG = "app.rekord.client";

export function adb(device, ...args) {
  const prefix = device ? ["adb", "-s", device] : ["adb"];
  return execSync([...prefix, ...args].join(" "), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Primo device USB connesso, o ADB_DEVICE env. */
export function resolveDevice() {
  const env = process.env.ADB_DEVICE?.trim();
  if (env) return env;
  const out = execSync("adb devices", { encoding: "utf8" });
  const serial = out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*") && l.endsWith("device"))
    .map((l) => l.split(/\s+/)[0])[0];
  if (!serial) throw new Error("Nessun device ADB connesso");
  return serial;
}

export function getAppPid(device) {
  const raw = adb(device, `shell pidof ${PKG}`);
  const pid = raw.split(/\s+/)[0];
  if (!pid) throw new Error(`App ${PKG} non in esecuzione`);
  return Number(pid);
}

export function setupCdpForward(device, port = 9222) {
  const pid = getAppPid(device);
  try {
    adb(device, "forward", "--remove", `tcp:${port}`);
  } catch {
    /* ignore */
  }
  adb(
    device,
    "forward",
    `tcp:${port}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
  return pid;
}

export function clearLogcat(device) {
  try {
    adb(device, "logcat", "-c");
  } catch {
    /* ignore */
  }
}

export function readFatalLogcat(device) {
  try {
    const out = adb(
      device,
      'shell logcat -d -s AndroidRuntime:E chromium:E',
    );
    return out
      .split("\n")
      .filter((l) => /FATAL|AndroidRuntime|crash/i.test(l))
      .slice(-20);
  } catch {
    return [];
  }
}

export function adbHome(device) {
  adb(device, "shell input keyevent KEYCODE_HOME");
}

export function adbWake(device) {
  adb(device, `shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
}

export function adbScreenOff(device) {
  adb(device, "shell input keyevent KEYCODE_POWER");
}
