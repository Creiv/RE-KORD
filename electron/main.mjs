import { app, BrowserWindow, dialog, Menu } from "electron"
import { resolveCloudflaredPath, isCloudflaredAvailable } from "../server/cloudflaredBin.mjs"
import { resolveYtdlpPath } from "../server/ytdlpPath.mjs"
import { spawn } from "child_process"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import http from "http"
import { applyChromiumGlassFlags, ELECTRON_WINDOW_BG } from "./chromium-glass.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

applyChromiumGlassFlags()

const DEFAULT_SERVER_PORT = 3001
const PORT_FILE = "rekord-electron-port.json"
let appPort =
  Number(process.env.REKORD_PORT || process.env.KORD_PORT || process.env.PORT) ||
  DEFAULT_SERVER_PORT

function isPackageSmokeMode() {
  return process.argv.includes("--package-smoke")
}

function isDev() {
  return !app.isPackaged
}

function getProjectRoot() {
  if (isDev()) {
    return path.join(__dirname, "..")
  }
  return path.join(process.resourcesPath, "app.asar.unpacked")
}

function getServerPath() {
  return path.join(getProjectRoot(), "server", "index.mjs")
}

function appendLaunchLog(message) {
  try {
    const p = path.join(app.getPath("userData"), "rekord-launch.log")
    const line = `${new Date().toISOString()} ${message}\n`
    fs.appendFileSync(p, line, "utf8")
  } catch {
    /* ok */
  }
}

function ensureUserDataConfig() {
  const dir = app.getPath("userData")
  fs.mkdirSync(dir, { recursive: true })
  const configPath = path.join(dir, "music-root.config.json")
  if (fs.existsSync(configPath)) return
  let defaultRoot = app.getPath("music")
  try {
    if (!fs.existsSync(defaultRoot)) {
      const fallback = path.join(app.getPath("home"), "Music")
      if (fs.existsSync(fallback)) defaultRoot = fallback
    }
  } catch {
    /* ok */
  }
    fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        musicRoot: defaultRoot,
        schemaVersion: 3,
      },
      null,
      2,
    ),
    "utf8",
  )
}

function getPortFilePath() {
  return path.join(app.getPath("userData"), PORT_FILE)
}

function hasExplicitServerPortFromEnv() {
  const k = process.env.REKORD_PORT || process.env.KORD_PORT
  if (k != null && String(k).trim() !== "") return true
  const p = process.env.PORT
  if (p != null && String(p).trim() !== "") return true
  return false
}

function readPersistedServerPort() {
  try {
    const raw = fs.readFileSync(getPortFilePath(), "utf8")
    const n = JSON.parse(raw)?.serverPort
    const v = Number(n)
    if (Number.isFinite(v) && v >= 1 && v <= 65535) return Math.floor(v)
  } catch {
    /* ok */
  }
  return null
}

function writePersistedServerPort(p) {
  try {
    fs.writeFileSync(
      getPortFilePath(),
      JSON.stringify({ serverPort: p, savedAt: new Date().toISOString() }, null, 2),
      "utf8",
    )
  } catch (e) {
    appendLaunchLog(`warn: could not save ${PORT_FILE} ${e}`)
  }
}

function makeStartupToken() {
  return `rk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function waitForHealth(port, startupToken, maxMs) {
  const start = Date.now()
  const healthPath = `/api/health?startupToken=${encodeURIComponent(startupToken)}`
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (Date.now() - start > maxMs) {
        reject(new Error("Timeout: server did not respond"))
        return
      }
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: healthPath,
          method: "GET",
          timeout: 1500,
        },
        (res) => {
          const chunks = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () => {
            if (!res.statusCode || res.statusCode >= 500) {
              setTimeout(tryOnce, 200)
              return
            }
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
              if (body?.data?.startupToken === startupToken) resolve()
              else setTimeout(tryOnce, 200)
            } catch {
              setTimeout(tryOnce, 200)
            }
          })
        },
      )
      req.on("error", () => setTimeout(tryOnce, 200))
      req.on("timeout", () => {
        try {
          req.destroy()
        } catch {
          /* ok */
        }
        setTimeout(tryOnce, 200)
      })
      req.end()
    }
    tryOnce()
  })
}

let serverChild = null
let mainWindow = null
/** Ultimo token usato per avviare il server (health probe prima di caricare la UI). */
let lastServerStartupToken = null
/** Health già verificato in tryStartOnPort — evita doppio probe in createWindow. */
let serverHealthConfirmed = false

const APP_NAME = "RE-KORD"

/** Switch Chromium che rompono ELECTRON_RUN_AS_NODE nel child server (--no-sandbox ecc.). */
const CHROME_SWITCHES_STRIPPED_FOR_NODE_CHILD = [
  "no-sandbox",
  "disable-gpu-sandbox",
  "ignore-gpu-blocklist",
  "enable-gpu-rasterization",
]

function stripChromeSwitchesForNodeSpawn() {
  const stripped = []
  for (const sw of CHROME_SWITCHES_STRIPPED_FOR_NODE_CHILD) {
    if (!app.commandLine.hasSwitch(sw)) continue
    const val = app.commandLine.getSwitchValue(sw)
    stripped.push({ sw, val })
    app.commandLine.removeSwitch(sw)
  }
  return stripped
}

function restoreChromeSwitches(stripped) {
  for (const { sw, val } of stripped) {
    if (val) app.commandLine.appendSwitch(sw, val)
    else app.commandLine.appendSwitch(sw)
  }
}

function getAppIconPath() {
  const root = path.join(__dirname, "..")
  const icoDist = path.join(root, "dist", "icon.ico")
  const icoPublic = path.join(root, "public", "icon.ico")
  const pngDist = path.join(root, "dist", "REKORDlogo.png")
  const pngPublic = path.join(root, "public", "REKORDlogo.png")
  if (process.platform === "win32") {
    if (fs.existsSync(icoDist)) return icoDist
    if (fs.existsSync(icoPublic)) return icoPublic
  }
  return [pngDist, pngPublic].find((p) => fs.existsSync(p)) || undefined
}

function installAppMenu() {
  const isMac = process.platform === "darwin"
  const viewItems = [
    { role: "reload", label: "Reload" },
    { role: "forceReload", label: "Reload (clear cache)" },
  ]
  if (isDev()) {
    viewItems.push(
      { role: "toggleDevTools", label: "Developer Tools" },
      { type: "separator" },
    )
  }
  viewItems.push(
    { role: "resetZoom", label: "Actual size" },
    { role: "zoomIn", label: "Zoom in" },
    { role: "zoomOut", label: "Zoom out" },
    { type: "separator" },
    { role: "togglefullscreen", label: "Full screen" },
  )
  const template = []
  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: "about", label: "About" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "Hide" },
        { role: "hideOthers", label: "Hide Others" },
        { role: "unhide", label: "Show All" },
        { type: "separator" },
        { role: "quit", label: "Quit" },
      ],
    })
    template.push({
      label: "File",
      submenu: [{ role: "close", label: "Close Window" }],
    })
  } else {
    template.push({
      label: "File",
      submenu: [
        { role: "quit", label: "Quit", accelerator: "Ctrl+Q" },
      ],
    })
  }
  template.push(
    {
      label: "Edit",
      submenu: [
        { role: "undo", label: "Undo" },
        { role: "redo", label: "Redo" },
        { type: "separator" },
        { role: "cut", label: "Cut" },
        { role: "copy", label: "Copy" },
        { role: "paste", label: "Paste" },
        { type: "separator" },
        { role: "selectAll", label: "Select All" },
      ],
    },
    { label: "View", submenu: viewItems },
    {
      label: "Window",
      submenu: [
        { role: "minimize", label: "Minimize" },
        { role: "zoom", label: "Zoom" },
        { type: "separator" },
        { role: "close", label: "Close" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: APP_NAME,
              message: APP_NAME,
              detail: `Version ${app.getVersion()}\nPlatform: ${process.platform} ${process.arch}.`,
            })
          },
        },
      ],
    },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function pickPortDevOrExplicit() {
  return (
    Number(process.env.REKORD_PORT || process.env.KORD_PORT || process.env.PORT) ||
    DEFAULT_SERVER_PORT
  )
}

function serverStdioForPackaged(userData, useStdio) {
  if (useStdio || isDev()) return useStdio ? "inherit" : "ignore"
  try {
    const logPath = path.join(userData, "rekord-server.log")
    const fd = fs.openSync(logPath, "a")
    appendLaunchLog(`server log → ${logPath}`)
    return ["ignore", fd, fd]
  } catch (e) {
    appendLaunchLog(`warn: server log file ${e}`)
    return "ignore"
  }
}

async function tryStartOnPort(userData, port, useStdio, cwd, script) {
  const startupToken = makeStartupToken()
  lastServerStartupToken = startupToken
  const env = {
    ...process.env,
    REKORD_USER_CONFIG_DIR: userData,
    KORD_USER_CONFIG_DIR: userData,
    WPP_USER_CONFIG_DIR: userData,
    PORT: String(port),
    REKORD_STARTUP_TOKEN: startupToken,
    ELECTRON_RUN_AS_NODE: "1",
  }
  if (app.isPackaged && (process.platform === "linux" || process.platform === "win32")) {
    env.ELECTRON_DISABLE_SANDBOX = "1"
  }
  if (isCloudflaredAvailable()) {
    const cloudflared = resolveCloudflaredPath()
    env.REKORD_CLOUDFLARED_BIN = cloudflared
    appendLaunchLog(`cloudflared detected: ${cloudflared}`)
  } else {
    appendLaunchLog("warn: cloudflared not found in package or PATH")
  }
  const ytdlp = resolveYtdlpPath()
  if (ytdlp && ytdlp !== "yt-dlp") {
    env.YTDLP_PATH = ytdlp
    appendLaunchLog(`yt-dlp detected: ${ytdlp}`)
  }
  appendLaunchLog(`spawn server on ${port} cwd=${cwd}`)
  const strippedSwitches = stripChromeSwitchesForNodeSpawn()
  let child
  try {
    child = spawn(process.execPath, [script], {
      env,
      cwd,
      stdio: serverStdioForPackaged(userData, useStdio),
    })
  } finally {
    restoreChromeSwitches(strippedSwitches)
  }
  child.on("error", (err) => {
    console.error("[rekord] server", err)
    appendLaunchLog(`server spawn error: ${err}`)
  })
  child.on("spawn", () => {
    appendLaunchLog(`server pid ${child.pid}`)
  })
  const exitP = new Promise((resolve) => {
    child.once("exit", (c) => resolve(c))
  })
  const healthP = waitForHealth(String(port), startupToken, 45000)
    .then(() => "ok")
    .catch(() => "health-fail")
  const r = await Promise.race([healthP, exitP.then((code) => ({ exit: code }))])
  if (r !== "ok") {
    const detail =
      r && typeof r === "object" && "exit" in r
        ? `exit=${r.exit}`
        : String(r)
    appendLaunchLog(`server not healthy on ${port} (${detail}) — vedi rekord-server.log`)
    try {
      child.kill("SIGTERM")
    } catch {
      /* ok */
    }
    return false
  }
  if (child.exitCode != null) {
    appendLaunchLog(
      `server on ${port} rispondeva ma il processo è uscito (exit=${child.exitCode}) — porta occupata?`,
    )
    return false
  }
  serverChild = child
  serverHealthConfirmed = true
  serverChild.on("exit", (code) => {
    if (code !== 0 && code != null) {
      appendLaunchLog(`server exit ${code}`)
    }
  })
  return true
}

function readServerLogTail(userData, maxLines = 12) {
  try {
    const logPath = path.join(userData, "rekord-server.log")
    if (!fs.existsSync(logPath)) return ""
    const raw = fs.readFileSync(logPath, "utf8")
    const lines = raw.trim().split(/\r?\n/).filter(Boolean)
    if (!lines.length) return ""
    return lines.slice(-maxLines).join("\n")
  } catch {
    return ""
  }
}

async function startServer() {
  const userData = app.getPath("userData")
  const useStdio =
    isDev() ||
    process.env.REKORD_ELECTRON_LOG === "1" ||
    process.env.WPP_ELECTRON_LOG === "1"
  const cwd = getProjectRoot()
  const script = getServerPath()
  if (!fs.existsSync(script)) {
    throw new Error(`Server not found: ${script}`)
  }

  const explicit = hasExplicitServerPortFromEnv()
  if (isDev() || explicit) {
    appPort = pickPortDevOrExplicit()
    const ok = await tryStartOnPort(userData, appPort, useStdio, cwd, script)
    if (!ok) {
      throw new Error(
        `The server process exited immediately. If another instance is running or the port is busy, close the other window or restart the session.`,
      )
    }
    return
  }

  const preferred = readPersistedServerPort() ?? DEFAULT_SERVER_PORT
  const maxTries = 80
  for (let i = 0; i < maxTries; i++) {
    const tryPort = preferred + i
    if (tryPort > 65535) break
    const ok = await tryStartOnPort(userData, tryPort, useStdio, cwd, script)
    if (ok) {
      appPort = tryPort
      writePersistedServerPort(tryPort)
      appendLaunchLog(`persisted server port ${tryPort}`)
      return
    }
  }
  const logTail = readServerLogTail(userData)
  throw new Error(
    "Could not start the server on a free port. Close other apps using this range or set REKORD_PORT in the environment." +
      (logTail ? `\n\nUltimo output server:\n${logTail}` : ""),
  )
}

async function createWindow() {
  const p = String(appPort)
  const useRendererSandbox = !(process.platform === "linux" && app.isPackaged)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: APP_NAME,
    icon: getAppIconPath(),
    autoHideMenuBar: false,
    backgroundColor: ELECTRON_WINDOW_BG,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: useRendererSandbox,
    },
  })
  const clientQ = "rekordClient=1"
  const url = isDev()
    ? `http://127.0.0.1:5173?${clientQ}`
    : `http://127.0.0.1:${p}/?${clientQ}`
  if (!isDev() && lastServerStartupToken && !serverHealthConfirmed) {
    try {
      await waitForHealth(p, lastServerStartupToken, 15000)
    } catch (e) {
      appendLaunchLog(`warn: health before loadURL ${e}`)
    }
  }
  serverHealthConfirmed = false
  void mainWindow.loadURL(url)
  void mainWindow.webContents.on("did-fail-load", (_ev, code, reason) => {
    appendLaunchLog(`did-fail-load ${code} ${reason}`)
  })
  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function stopServer() {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill("SIGTERM")
    } catch {
      /* ok */
    }
    serverChild = null
  }
}

app.on("before-quit", () => {
  stopServer()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

if (!app.requestSingleInstanceLock()) {
  void app.whenReady().then(() => {
    try {
      dialog.showMessageBoxSync({
        type: "info",
        title: APP_NAME,
        message:
          "RE-KORD is already running (another instance is open). Check other windows, the taskbar or system tray, or end the RE-KORD process from Task Manager / System Monitor.",
      })
    } finally {
      app.quit()
    }
  })
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    app.setName(APP_NAME)
    ensureUserDataConfig()
    installAppMenu()
    appendLaunchLog("ready")
    try {
      await startServer()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLaunchLog(`error: ${msg}`)
      console.error(e)
      try {
        dialog.showErrorBox("RE-KORD — startup failed", `${msg}\n\nDetails: ${app.getPath("userData")}/rekord-launch.log`)
      } catch {
        /* ok */
      }
      app.quit()
      return
    }
    if (isPackageSmokeMode()) {
      appendLaunchLog("package-smoke: server health ok")
      stopServer()
      app.quit()
      return
    }
    createWindow()
  })
}
