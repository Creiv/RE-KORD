//! Shared fixture for the `http_*` integration tests: a hub on temp dirs,
//! driven through `build_router` with `tower::ServiceExt::oneshot`.

#![allow(dead_code)]

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use rekord_core::{build_router, prepare_hub_state, AppState, HubOptions, UiDirs};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tower::ServiceExt;

pub const LOCAL_HOST: &str = "127.0.0.1:7420";
pub const LAN_HOST: &str = "192.168.1.5:7420";

pub struct Hub {
    pub base: PathBuf,
    pub root: PathBuf,
    pub data: PathBuf,
    pub state: AppState,
    pub app: Router,
}

impl Hub {
    pub fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("rekord-http-{tag}-{}", uuid::Uuid::new_v4()));
        Self::with_dirs(base.clone(), base.join("music"), base.join("data"), None)
    }

    /// Hub that requires `key` on `/api` and `/media` (`REKORD_ACCESS_KEY`).
    pub fn with_access_key(tag: &str, key: &str) -> Self {
        let base = std::env::temp_dir().join(format!("rekord-http-{tag}-{}", uuid::Uuid::new_v4()));
        Self::with_dirs(
            base.clone(),
            base.join("music"),
            base.join("data"),
            Some(key),
        )
    }

    /// Hub whose data dir lives inside the music root (must still not be served).
    pub fn with_data_inside_root(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("rekord-http-{tag}-{}", uuid::Uuid::new_v4()));
        let root = base.join("music");
        Self::with_dirs(base.clone(), root.clone(), root.join("hubdata"), None)
    }

    fn with_dirs(base: PathBuf, root: PathBuf, data: PathBuf, access_key: Option<&str>) -> Self {
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        let opts = HubOptions {
            bind: "127.0.0.1:0".parse().unwrap(),
            data_dir: data.clone(),
            client_ui_dir: None,
            admin_ui_dir: None,
        };
        let state = prepare_hub_state(&opts, Some(&root), None).unwrap();
        if let Some(key) = access_key {
            state.access_key.set(
                rekord_core::access_key::AccessGate::new(key).unwrap(),
                rekord_core::access_key::KeySource::Env,
            );
        }
        let app = build_router(state.clone(), UiDirs::default());
        Self {
            base,
            root,
            data,
            state,
            app,
        }
    }

    pub fn file(&self, rel: &str, body: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    pub fn set_allow_remote_admin(&self, on: bool) {
        self.state.config.lock().unwrap().allow_remote_admin = on;
    }

    pub async fn send(&self, req: Request<Body>) -> Resp {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Resp {
            status,
            headers,
            body,
        }
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }
}

/// Where the request comes from.
#[derive(Clone, Copy)]
pub enum From {
    /// Browser / app on the hub machine.
    Local,
    /// Another device on the LAN.
    Lan,
    /// Cloudflare tunnel: cloudflared connects from loopback with cf headers.
    Tunnel,
}

pub struct Req {
    method: Method,
    uri: String,
    from: From,
    headers: Vec<(String, String)>,
    body: Body,
}

pub fn req(method: Method, uri: &str) -> Req {
    Req {
        method,
        uri: uri.to_string(),
        from: From::Local,
        headers: Vec::new(),
        body: Body::empty(),
    }
}

impl Req {
    pub fn from(mut self, from: From) -> Self {
        self.from = from;
        self
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }

    pub fn json(mut self, v: serde_json::Value) -> Self {
        self.headers
            .push(("content-type".into(), "application/json".into()));
        self.body = Body::from(serde_json::to_vec(&v).unwrap());
        self
    }

    pub fn raw_body(mut self, content_type: &str, bytes: Vec<u8>) -> Self {
        self.headers
            .push(("content-type".into(), content_type.to_string()));
        self.body = Body::from(bytes);
        self
    }

    pub fn build(self) -> Request<Body> {
        let (host, peer): (&str, SocketAddr) = match self.from {
            From::Local => (LOCAL_HOST, "127.0.0.1:50000".parse().unwrap()),
            From::Lan => (LAN_HOST, "192.168.1.20:50000".parse().unwrap()),
            From::Tunnel => (
                "abc-def.trycloudflare.com",
                "127.0.0.1:50001".parse().unwrap(),
            ),
        };
        let mut b = Request::builder().method(self.method).uri(&self.uri);
        let has_host = self
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("host"));
        if !has_host {
            b = b.header("host", host);
        }
        if matches!(self.from, From::Tunnel) {
            b = b
                .header("cf-connecting-ip", "8.8.8.8")
                .header("cf-ray", "abc123");
        }
        for (k, v) in &self.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        let mut r = b.body(self.body).unwrap();
        r.extensions_mut().insert(ConnectInfo(peer));
        r
    }
}

/// Minimal multipart body with one `file` field.
pub fn multipart_file(filename: &str, content_type: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = "rekordtestboundary7MA4YWxk";
    let mut out = Vec::new();
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(bytes);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), out)
}

pub fn exists(p: &Path) -> bool {
    p.exists()
}
