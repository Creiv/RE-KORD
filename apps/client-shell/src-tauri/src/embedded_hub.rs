//! Embedded hub ("server flavor", `hub` feature, desktop only).
//!
//! The 5.0 Electron "Server" app started the hub together with the window. Here
//! `rekord_core::run_hub` runs on a tokio runtime in its own thread, so the
//! window never waits for the hub and the hub doesn't depend on the event loop.
//! The client in the window finds it on its own: on startup it already tries
//! `http://127.0.0.1:7420`.
//!
//! Configuration, in order of precedence:
//! 1. environment variables `REKORD_EMBEDDED_HUB=0` (turns it off), `REKORD_BIND`,
//!    `REKORD_DATA_DIR` (same names as `rekord-server`);
//! 2. `<app data dir>/hub.json` → `{ "enabled": true, "bind": "0.0.0.0:7420",
//!    "dataDir": null }`, created with these values on first launch;
//! 3. defaults: `0.0.0.0:7420` (reachable on the LAN, like the 5.0 app) and data
//!    in `<app data dir>/hub`.

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const DEFAULT_BIND: &str = "0.0.0.0:7420";
const CONFIG_FILE: &str = "hub.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubFileConfig {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default = "default_bind")]
    bind: String,
    #[serde(default)]
    data_dir: Option<PathBuf>,
}

fn default_enabled() -> bool {
    true
}

fn default_bind() -> String {
    DEFAULT_BIND.to_string()
}

impl Default for HubFileConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bind: default_bind(),
            data_dir: None,
        }
    }
}

struct Running {
    shutdown: Option<oneshot::Sender<()>>,
    done: std::sync::mpsc::Receiver<()>,
}

#[derive(Default)]
struct HubHandle(Mutex<Option<Running>>);

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn load_config(app_data: &Path) -> HubFileConfig {
    let path = app_data.join(CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            eprintln!("[rekord] {} invalid ({e}): using defaults", path.display());
            HubFileConfig::default()
        }),
        Err(_) => {
            let cfg = HubFileConfig::default();
            // Written right away: whoever wants to change the port or folder finds
            // the file ready instead of having to guess its format.
            if std::fs::create_dir_all(app_data).is_ok() {
                if let Ok(raw) = serde_json::to_string_pretty(&cfg) {
                    let _ = std::fs::write(&path, raw);
                }
            }
            cfg
        }
    }
}

/// UI bundled as a resource (`tauri.hub.conf.json`), if present: `admin-ui` for
/// the panel on /admin, `client-ui` for phones and browsers on the LAN or
/// through the tunnel that open http://<pc>:7420/.
fn bundled_ui(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join(name);
    dir.join("index.html").is_file().then_some(dir)
}

/// yt-dlp, qjs (its JavaScript runtime), cloudflared and ffmpeg bundled in
/// `bin/` (pnpm pack:*:server): the hub looks them up through the same
/// environment variables as `rekord-server`, which still take priority if the
/// user has already set them.
fn export_bundled_tools(app: &AppHandle) {
    let Ok(bin) = app.path().resource_dir().map(|d| d.join("bin")) else {
        return;
    };
    let exe = |name: &str| {
        let file = if cfg!(windows) {
            bin.join(format!("{name}.exe"))
        } else {
            bin.join(name)
        };
        file.is_file().then_some(file)
    };
    for (var, name) in [
        ("YTDLP_PATH", "yt-dlp"),
        ("REKORD_YTDLP_JS_BIN", "qjs"),
        ("REKORD_CLOUDFLARED_BIN", "cloudflared"),
        ("REKORD_FFMPEG", "ffmpeg"),
    ] {
        if env_nonempty(var).is_some() {
            continue;
        }
        if let Some(path) = exe(name) {
            std::env::set_var(var, path);
        }
    }
}

pub fn start(app: &AppHandle) {
    app.manage(HubHandle::default());

    let app_data = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[rekord] embedded hub not started: unknown app data folder ({e})");
            return;
        }
    };
    let file = load_config(&app_data);
    let enabled = match env_nonempty("REKORD_EMBEDDED_HUB") {
        Some(v) => !matches!(v.as_str(), "0" | "false" | "off"),
        None => file.enabled,
    };
    if !enabled {
        eprintln!("[rekord] embedded hub disabled (hub.json / REKORD_EMBEDDED_HUB)");
        return;
    }
    // Same check `run_hub` does, made here so the window can say why there is
    // no hub instead of only "unreachable". The message never contains the key.
    if let Err(e) = rekord_core::access_key::gate_from_env() {
        eprintln!("[rekord] embedded hub not started: {e}");
        if let Some(state) = app.try_state::<crate::HubStartError>() {
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some("access_key_config");
        }
        return;
    }

    let bind_raw = env_nonempty("REKORD_BIND").unwrap_or(file.bind.clone());
    let bind: SocketAddr = match bind_raw.parse() {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("[rekord] invalid hub address «{bind_raw}» ({e}): using {DEFAULT_BIND}");
            DEFAULT_BIND.parse().expect("default bind")
        }
    };
    let data_dir = env_nonempty("REKORD_DATA_DIR")
        .map(PathBuf::from)
        .or(file.data_dir.clone())
        .unwrap_or_else(|| app_data.join("hub"));

    let opts = rekord_core::HubOptions {
        bind,
        data_dir,
        // The window uses Tauri's copy; this one is for the other devices.
        client_ui_dir: bundled_ui(app, "client-ui"),
        admin_ui_dir: bundled_ui(app, "admin-ui"),
    };
    // Before starting the hub runtime: no other hub thread reads the
    // environment yet.
    export_bundled_tools(app);

    let (tx, rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("rekord-hub".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("rekord-hub-worker")
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[rekord] hub runtime not created: {e}");
                    let _ = done_tx.send(());
                    return;
                }
            };
            let shutdown = async move {
                let _ = rx.await;
            };
            if let Err(e) = runtime.block_on(rekord_core::run_hub(opts, shutdown)) {
                // Typically the port is already taken by a standalone
                // rekord-server: the client will connect to that one.
                eprintln!("[rekord] embedded hub stopped: {e:#}");
            }
            runtime.shutdown_timeout(Duration::from_secs(2));
            let _ = done_tx.send(());
        });

    match spawned {
        Ok(_) => {
            if let Some(handle) = app.try_state::<HubHandle>() {
                *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running {
                    shutdown: Some(tx),
                    done: done_rx,
                });
            }
        }
        Err(e) => eprintln!("[rekord] hub thread not started: {e}"),
    }
}

/// Orderly shutdown when the app exits: no DB left half-written.
pub fn stop(app: &AppHandle) {
    let Some(handle) = app.try_state::<HubHandle>() else {
        return;
    };
    let Some(mut running) = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    if let Some(tx) = running.shutdown.take() {
        let _ = tx.send(());
    }
    if running.done.recv_timeout(Duration::from_secs(8)).is_err() {
        eprintln!("[rekord] hub did not stop in time: forcing shutdown");
    }
}
