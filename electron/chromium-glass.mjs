import { app } from "electron"

/** Flag Chromium utili al backdrop-filter (vetro) nei build impacchettati. */
export function applyChromiumGlassFlags() {
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("no-sandbox")
    app.commandLine.appendSwitch("disable-gpu-sandbox")
  }
  if (app.isPackaged) {
    app.commandLine.appendSwitch("ignore-gpu-blocklist")
    app.commandLine.appendSwitch("enable-gpu-rasterization")
  }
}

export const ELECTRON_WINDOW_BG = "#060810"
