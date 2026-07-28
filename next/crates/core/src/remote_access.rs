//! Remote access via Cloudflare quick tunnel (cloudflared) + LAN URL helpers.
//! Behaviour mirrors legacy `server/remoteAccess.mjs`.

use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tracing::{info, warn};

const CF_DASHBOARD: &str = "https://dash.cloudflare.com/";
const TUNNEL_START_TIMEOUT_MS: u64 = 90_000;
const OUTPUT_BUFFER_MAX: usize = 64 * 1024;
const PROVIDER: &str = "cloudflare-quick";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

impl RemoteStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Error => "error",
        }
    }
}

struct RemoteInner {
    enabled: bool,
    status: RemoteStatus,
    public_url: Option<String>,
    error: Option<String>,
    started_at: Option<String>,
    cloudflared_path: Option<PathBuf>,
    cloudflare_logged_in: bool,
    child: Option<Child>,
    /// Bumped on stop / new start to cancel in-flight readers.
    generation: u64,
    stop_tx: Option<oneshot::Sender<()>>,
    logged_in_loaded: bool,
}

impl Default for RemoteInner {
    fn default() -> Self {
        Self {
            enabled: false,
            status: RemoteStatus::Stopped,
            public_url: None,
            error: None,
            started_at: None,
            cloudflared_path: None,
            cloudflare_logged_in: false,
            child: None,
            generation: 0,
            stop_tx: None,
            logged_in_loaded: false,
        }
    }
}

struct RemoteAccessManager {
    inner: Mutex<RemoteInner>,
}

impl RemoteAccessManager {
    fn new() -> Self {
        Self {
            inner: Mutex::new(RemoteInner::default()),
        }
    }
}

fn manager() -> &'static RemoteAccessManager {
    static M: OnceLock<RemoteAccessManager> = OnceLock::new();
    M.get_or_init(RemoteAccessManager::new)
}

fn ok<T: Serialize>(data: T) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "ok": false, "error": msg.into() }))).into_response()
}

fn guess_lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

pub fn lan_url_for_port(port: u16) -> Option<String> {
    guess_lan_ip().map(|ip| format!("http://{ip}:{port}"))
}

/// Extract trycloudflare URL from cloudflared stdout/stderr (may be split across chunks).
pub fn extract_cloudflare_tunnel_url(buffer: &str) -> Option<String> {
    let lower = buffer.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(".trycloudflare.com") {
        let end = search_from + rel + ".trycloudflare.com".len();
        let before = &buffer[..end];
        if let Some(start) = before.rfind("https://") {
            let url = &buffer[start..end];
            let host = &url["https://".len()..];
            if let Some(label) = host.strip_suffix(".trycloudflare.com") {
                if !label.is_empty()
                    && label
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
                {
                    return Some(url.to_string());
                }
            }
        }
        search_from = end;
    }
    None
}

fn normalize_url_simple(input: &str) -> Option<String> {
    let raw = input.trim().trim_end_matches('/');
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let mut parsed = url::Url::parse(&with_scheme).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "trycloudflare.com" || host.ends_with(".trycloudflare.com") {
        let _ = parsed.set_scheme("https");
        let _ = parsed.set_port(None);
        return Some(format!("https://{}", parsed.host_str()?));
    }
    let port = parsed.port();
    let host_disp = match port {
        Some(p) => format!("{}:{p}", parsed.host_str()?),
        None => parsed.host_str()?.to_string(),
    };
    Some(format!("{}//{host_disp}", parsed.scheme()))
}

fn cloudflared_bin_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn candidate_bundled_paths() -> Vec<PathBuf> {
    let name = cloudflared_bin_name();
    let mut out = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("server/bin").join(name));
        out.push(cwd.join("../server/bin").join(name));
        out.push(cwd.join("../../server/bin").join(name));
        out.push(cwd.join("bin").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(name));
            out.push(dir.join("bin").join(name));
            out.push(dir.join("../server/bin").join(name));
            out.push(dir.join("../../server/bin").join(name));
        }
    }
    out
}

fn resolve_cloudflared_path() -> PathBuf {
    if let Ok(configured) = std::env::var("REKORD_CLOUDFLARED_BIN") {
        let t = configured.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    for p in candidate_bundled_paths() {
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(cloudflared_bin_name())
}

fn expected_cloudflared_install_path() -> String {
    candidate_bundled_paths()
        .into_iter()
        .next()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| cloudflared_bin_name().to_string())
}

fn cloudflared_version_ok(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn is_cloudflared_available() -> bool {
    let path = resolve_cloudflared_path();
    cloudflared_version_ok(&path)
}

fn load_logged_in(data_dir: &Path) -> bool {
    let path = data_dir.join("settings.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    v.get("cloudflareLoggedIn")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

fn persist_logged_in(data_dir: &Path, value: bool) -> Result<(), String> {
    let path = data_dir.join("settings.json");
    let mut v = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    if !v.is_object() {
        v = json!({});
    }
    v["cloudflareLoggedIn"] = json!(value);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn snapshot_json(inner: &RemoteInner, lan_url: Option<String>, bind: String) -> serde_json::Value {
    let public_url = match inner.status {
        RemoteStatus::Running => inner.public_url.clone(),
        RemoteStatus::Starting => None,
        _ => std::env::var("REKORD_PUBLIC_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .and_then(|u| normalize_url_simple(&u).or(Some(u))),
    };
    json!({
        "enabled": inner.enabled,
        "status": inner.status.as_str(),
        "provider": PROVIDER,
        "publicUrl": public_url,
        "error": inner.error.clone(),
        "startedAt": inner.started_at.clone(),
        "cloudflaredPath": inner.cloudflared_path.as_ref().map(|p| p.display().to_string()),
        "cloudflareLoggedIn": inner.cloudflare_logged_in,
        "lanUrl": lan_url,
        "bind": bind,
        "cloudflaredAvailable": is_cloudflared_available(),
    })
}

fn ensure_logged_in_loaded(inner: &mut RemoteInner, data_dir: &Path) {
    if inner.logged_in_loaded {
        return;
    }
    inner.cloudflare_logged_in = load_logged_in(data_dir);
    inner.logged_in_loaded = true;
}

fn kill_child(inner: &mut RemoteInner) {
    if let Some(tx) = inner.stop_tx.take() {
        let _ = tx.send(());
    }
    if let Some(mut child) = inner.child.take() {
        let _ = child.start_kill();
    }
}

fn mark_error(inner: &mut RemoteInner, msg: impl Into<String>) {
    let msg = msg.into();
    inner.enabled = false;
    inner.status = RemoteStatus::Error;
    inner.public_url = None;
    if msg.contains("ENOENT") || msg.contains("No such file") {
        inner.error = Some(format!(
            "Cloudflared non trovato (atteso in {}). Reinstalla RE-KORD oppure configura REKORD_CLOUDFLARED_BIN.",
            expected_cloudflared_install_path()
        ));
    } else {
        inner.error = Some(msg);
    }
}

async fn stop_inner() {
    let mut inner = manager().inner.lock().unwrap();
    inner.generation = inner.generation.wrapping_add(1);
    kill_child(&mut inner);
    inner.enabled = false;
    inner.status = RemoteStatus::Stopped;
    inner.public_url = None;
    inner.error = None;
    inner.started_at = None;
}

fn apply_found_url(generation: u64, url: String, data_dir: &Path) -> bool {
    let normalized = normalize_url_simple(&url).unwrap_or(url);
    let mut inner = manager().inner.lock().unwrap();
    if inner.generation != generation || inner.status != RemoteStatus::Starting {
        return false;
    }
    inner.status = RemoteStatus::Running;
    inner.public_url = Some(normalized.clone());
    inner.error = None;
    info!(public_url = %normalized, "Cloudflare tunnel URL ready");
    crate::diagnostics::append_activity(data_dir, "remote", &format!("tunnel url: {normalized}"));
    true
}

fn append_output(buffer: &mut String, line: &str) {
    buffer.push_str(line);
    buffer.push('\n');
    if buffer.len() > OUTPUT_BUFFER_MAX {
        *buffer = buffer[buffer.len() - OUTPUT_BUFFER_MAX..].to_string();
    }
}

fn start_tunnel(port: u16, data_dir: PathBuf) {
    let mut inner = manager().inner.lock().unwrap();
    if inner.status == RemoteStatus::Running || inner.status == RemoteStatus::Starting {
        return;
    }

    if let Ok(url) = std::env::var("REKORD_PUBLIC_URL") {
        let url = url.trim().to_string();
        if !url.is_empty() {
            let normalized = normalize_url_simple(&url).unwrap_or(url);
            inner.enabled = true;
            inner.status = RemoteStatus::Running;
            inner.public_url = Some(normalized.clone());
            inner.error = None;
            inner.started_at = Some(chrono::Utc::now().to_rfc3339());
            crate::diagnostics::append_activity(
                &data_dir,
                "remote",
                &format!("public url set: {normalized}"),
            );
            return;
        }
    }

    let path = resolve_cloudflared_path();
    inner.cloudflared_path = Some(path.clone());
    if !cloudflared_version_ok(&path) {
        mark_error(
            &mut inner,
            format!(
                "Cloudflared non trovato (atteso in {}). Reinstalla RE-KORD Server.",
                expected_cloudflared_install_path()
            ),
        );
        return;
    }

    kill_child(&mut inner);
    inner.generation = inner.generation.wrapping_add(1);
    let generation = inner.generation;
    inner.enabled = true;
    inner.status = RemoteStatus::Starting;
    inner.public_url = None;
    inner.error = None;
    inner.started_at = Some(chrono::Utc::now().to_rfc3339());

    let target = format!("http://127.0.0.1:{port}");
    info!(cloudflared = %path.display(), %target, "starting Cloudflare quick tunnel");

    let mut cmd = Command::new(&path);
    cmd.args(["tunnel", "--url", &target, "--no-autoupdate"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            mark_error(&mut inner, e.to_string());
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    inner.stop_tx = Some(stop_tx);
    inner.child = Some(child);
    drop(inner);

    crate::diagnostics::append_activity(&data_dir, "remote", "cloudflared tunnel start requested");

    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stop_rx = stop_rx;
        let mut stdout_lines = stdout.map(|s| BufReader::new(s).lines());
        let mut stderr_lines = stderr.map(|s| BufReader::new(s).lines());
        let deadline = tokio::time::Instant::now() + Duration::from_millis(TUNNEL_START_TIMEOUT_MS);
        let mut url_found = false;

        while !url_found {
            if tokio::time::Instant::now() >= deadline {
                let mut inner = manager().inner.lock().unwrap();
                if inner.generation == generation && inner.status == RemoteStatus::Starting {
                    mark_error(
                        &mut inner,
                        "Timeout avvio tunnel: cloudflared non ha restituito un URL pubblico.",
                    );
                    kill_child(&mut inner);
                }
                return;
            }

            let stdout_done = stdout_lines.is_none();
            let stderr_done = stderr_lines.is_none();
            if stdout_done && stderr_done {
                let mut inner = manager().inner.lock().unwrap();
                if inner.generation == generation && inner.status == RemoteStatus::Starting {
                    mark_error(&mut inner, "Tunnel terminato prima di essere pronto");
                    kill_child(&mut inner);
                }
                return;
            }

            tokio::select! {
                _ = &mut stop_rx => return,
                res = async {
                    match stdout_lines.as_mut() {
                        Some(lines) => lines.next_line().await,
                        None => std::future::pending().await,
                    }
                }, if !stdout_done => {
                    match res {
                        Ok(Some(line)) => {
                            append_output(&mut buffer, &line);
                            if let Some(url) = extract_cloudflare_tunnel_url(&buffer) {
                                url_found = apply_found_url(generation, url, &data_dir);
                            }
                        }
                        Ok(None) => stdout_lines = None,
                        Err(e) => {
                            warn!(error = %e, "cloudflared stdout read error");
                            stdout_lines = None;
                        }
                    }
                }
                res = async {
                    match stderr_lines.as_mut() {
                        Some(lines) => lines.next_line().await,
                        None => std::future::pending().await,
                    }
                }, if !stderr_done => {
                    match res {
                        Ok(Some(line)) => {
                            append_output(&mut buffer, &line);
                            if let Some(url) = extract_cloudflare_tunnel_url(&buffer) {
                                url_found = apply_found_url(generation, url, &data_dir);
                            }
                        }
                        Ok(None) => stderr_lines = None,
                        Err(e) => {
                            warn!(error = %e, "cloudflared stderr read error");
                            stderr_lines = None;
                        }
                    }
                }
            }
        }

        // Wait until stop signal or process exit (never hold MutexGuard across await).
        let child_wait = async {
            let child = loop {
                let taken: Option<Option<Child>> = {
                    let mut guard = manager().inner.lock().unwrap();
                    if guard.generation != generation {
                        None
                    } else {
                        Some(guard.child.take())
                    }
                };
                match taken {
                    None => return, // superseded
                    Some(Some(child)) => break child,
                    Some(None) => tokio::time::sleep(Duration::from_millis(200)).await,
                }
            };
            let status = {
                let mut child = child;
                child.wait().await
            };
            let mut guard = manager().inner.lock().unwrap();
            if guard.generation != generation {
                return;
            }
            if guard.enabled {
                match status {
                    Ok(_) => mark_error(&mut guard, "Tunnel terminato"),
                    Err(e) => mark_error(&mut guard, e.to_string()),
                }
            } else {
                guard.status = RemoteStatus::Stopped;
                guard.public_url = None;
            }
        };

        tokio::select! {
            _ = stop_rx => {}
            _ = child_wait => {}
        }
    });
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/remote-access", get(remote_status))
        .route("/api/remote-access", get(remote_status))
        .route("/api/v1/remote-access/start", post(remote_start))
        .route("/api/remote-access/start", post(remote_start))
        .route("/api/v1/remote-access/stop", post(remote_stop))
        .route("/api/remote-access/stop", post(remote_stop))
        .route("/api/v1/remote-access/login", post(remote_login))
        .route("/api/remote-access/login", post(remote_login))
        .route("/api/v1/remote-access/logout", post(remote_logout))
        .route("/api/remote-access/logout", post(remote_logout))
}

async fn remote_status(State(state): State<AppState>) -> Response {
    let cfg = state.config.lock().unwrap().clone();
    let lan = lan_url_for_port(cfg.bind.port());
    let bind = cfg.bind.to_string();
    let data_dir = cfg.data_dir.clone();
    let mut inner = manager().inner.lock().unwrap();
    ensure_logged_in_loaded(&mut inner, &data_dir);
    ok(snapshot_json(&inner, lan, bind))
}

async fn remote_start(State(state): State<AppState>) -> Response {
    let cfg = state.config.lock().unwrap().clone();
    let port = cfg.bind.port();
    let data_dir = cfg.data_dir.clone();
    let lan = lan_url_for_port(port);
    let bind = cfg.bind.to_string();
    {
        let mut inner = manager().inner.lock().unwrap();
        ensure_logged_in_loaded(&mut inner, &data_dir);
        if inner.status == RemoteStatus::Running || inner.status == RemoteStatus::Starting {
            return ok(snapshot_json(&inner, lan, bind));
        }
    }
    start_tunnel(port, data_dir);
    let inner = manager().inner.lock().unwrap();
    if inner.status == RemoteStatus::Error
        && !is_cloudflared_available()
        && std::env::var("REKORD_PUBLIC_URL")
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
    {
        let msg = inner
            .error
            .clone()
            .unwrap_or_else(|| "cloudflared non trovato".into());
        return err(StatusCode::SERVICE_UNAVAILABLE, msg);
    }
    ok(snapshot_json(&inner, lan, bind))
}

async fn remote_stop(State(state): State<AppState>) -> Response {
    let cfg = state.config.lock().unwrap().clone();
    let data_dir = cfg.data_dir.clone();
    let lan = lan_url_for_port(cfg.bind.port());
    let bind = cfg.bind.to_string();
    stop_inner().await;
    crate::diagnostics::append_activity(&data_dir, "remote", "tunnel stopped");
    let mut inner = manager().inner.lock().unwrap();
    ensure_logged_in_loaded(&mut inner, &data_dir);
    ok(snapshot_json(&inner, lan, bind))
}

async fn remote_login(State(state): State<AppState>) -> Response {
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    if let Err(e) = persist_logged_in(&data_dir, true) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut inner = manager().inner.lock().unwrap();
    inner.cloudflare_logged_in = true;
    inner.logged_in_loaded = true;
    ok(json!({
        "loginUrl": CF_DASHBOARD,
        "note": "Apri Cloudflare Dashboard e completa il login.",
        "cloudflareLoggedIn": true,
    }))
}

async fn remote_logout(State(state): State<AppState>) -> Response {
    let cfg = state.config.lock().unwrap().clone();
    let data_dir = cfg.data_dir.clone();
    let lan = lan_url_for_port(cfg.bind.port());
    let bind = cfg.bind.to_string();
    stop_inner().await;
    if let Err(e) = persist_logged_in(&data_dir, false) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut inner = manager().inner.lock().unwrap();
    inner.cloudflare_logged_in = false;
    inner.logged_in_loaded = true;
    crate::diagnostics::append_activity(&data_dir, "remote", "cloudflare logout");
    ok(snapshot_json(&inner, lan, bind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_url_from_cloudflared_line() {
        let line = "2024-01-01 INF |  https://abc-def.trycloudflare.com";
        assert_eq!(
            extract_cloudflare_tunnel_url(line).as_deref(),
            Some("https://abc-def.trycloudflare.com")
        );
    }

    #[test]
    fn extracts_url_across_chunks() {
        let buf = "foo https://xyz-123.trycloudflare.com bar";
        assert_eq!(
            extract_cloudflare_tunnel_url(buf).as_deref(),
            Some("https://xyz-123.trycloudflare.com")
        );
    }

    #[test]
    fn normalize_forces_https_for_trycloudflare() {
        assert_eq!(
            normalize_url_simple("http://abc.trycloudflare.com"),
            Some("https://abc.trycloudflare.com".into())
        );
    }
}
