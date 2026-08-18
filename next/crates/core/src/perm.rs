//! Permissions for "machine operations".
//!
//! A machine operation touches the host, not personal data: library path, scan,
//! watcher, layout, restore, credentials, tunnel. It requires the Default account
//! and, unless `allow_remote_admin` is set, a local (loopback) client.
//!
//! Unlike legacy "loopback = admin", remote clients (APK, LAN) stay fully
//! functional for personal data; only host-level writes are restricted.

use crate::accounts;
use crate::state::AppState;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

/// The connecting socket address when the server was started with
/// `into_make_service_with_connect_info`; `None` in tests and embedded routers.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeerAddr(pub Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for PeerAddr {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(PeerAddr(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr),
        ))
    }
}

/// Headers set by reverse proxies / tunnels: their presence means "not local",
/// even though cloudflared connects from 127.0.0.1.
const PROXY_HEADERS: &[&str] = &[
    "cf-connecting-ip",
    "cf-ray",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
];

fn host_is_local(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let bare = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(&host);
    let bare = bare.trim_matches(|c| c == '[' || c == ']');
    bare == "localhost"
        || bare == "127.0.0.1"
        || bare == "::1"
        || bare.ends_with(".localhost")
        || bare
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// True when the request came from this machine and not through a proxy/tunnel.
pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    if PROXY_HEADERS.iter().any(|h| headers.contains_key(*h)) {
        return false;
    }
    if let Some(host) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    {
        if !host_is_local(host) {
            return false;
        }
    }
    match peer {
        Some(addr) => addr.ip().is_loopback(),
        // Connect info unavailable: rely on the Host check above.
        None => true,
    }
}

pub struct MachineOp {
    pub account_id: String,
    pub local: bool,
}

fn forbidden(msg: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "ok": false, "error": msg })),
    )
        .into_response()
}

/// Authorise a machine operation, or produce the 403 response to return.
pub fn require_machine_op(
    state: &AppState,
    headers: &HeaderMap,
    query_account_id: Option<&str>,
    peer: Option<SocketAddr>,
) -> Result<MachineOp, Response> {
    let (data_dir, allow_remote) = {
        let cfg = state.config.lock().unwrap();
        (cfg.data_dir.clone(), cfg.allow_remote_admin)
    };
    let account_id = accounts::require_default_account(&data_dir, headers, query_account_id)
        .map_err(|_| forbidden("Solo l'account Default può eseguire le operazioni di macchina"))?;
    let local = is_local_request(headers, peer);
    if !local && !allow_remote {
        return Err(forbidden(
            "Operazione di macchina disponibile solo dal computer dell'hub (abilita l'accesso remoto nel pannello hub)",
        ));
    }
    Ok(MachineOp { account_id, local })
}

/// Describe the caller's machine-operation rights (used by the client to show
/// read-only sections).
pub fn machine_op_status(
    state: &AppState,
    headers: &HeaderMap,
    query_account_id: Option<&str>,
    peer: Option<SocketAddr>,
) -> serde_json::Value {
    let (data_dir, allow_remote) = {
        let cfg = state.config.lock().unwrap();
        (cfg.data_dir.clone(), cfg.allow_remote_admin)
    };
    let is_default =
        accounts::require_default_account(&data_dir, headers, query_account_id).is_ok();
    let local = is_local_request(headers, peer);
    json!({
        "isDefaultAccount": is_default,
        "local": local,
        "allowRemoteAdmin": allow_remote,
        "canManageMachine": is_default && (local || allow_remote),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            let name = axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap();
            h.insert(name, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn addr(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn loopback_host_and_peer_is_local() {
        let h = headers(&[("host", "localhost:7420")]);
        assert!(is_local_request(&h, addr("127.0.0.1:5000")));
        let h = headers(&[("host", "127.0.0.1:7420")]);
        assert!(is_local_request(&h, addr("127.0.0.1:5000")));
    }

    #[test]
    fn lan_host_is_not_local() {
        let h = headers(&[("host", "192.168.1.174:7420")]);
        assert!(!is_local_request(&h, addr("192.168.1.20:5000")));
    }

    #[test]
    fn cloudflare_tunnel_is_not_local_despite_loopback_peer() {
        let h = headers(&[
            ("host", "abc-def.trycloudflare.com"),
            ("cf-connecting-ip", "8.8.8.8"),
        ]);
        assert!(!is_local_request(&h, addr("127.0.0.1:5000")));
    }

    #[test]
    fn proxy_header_alone_marks_remote() {
        let h = headers(&[("host", "localhost:7420"), ("x-forwarded-for", "8.8.8.8")]);
        assert!(!is_local_request(&h, addr("127.0.0.1:5000")));
    }

    #[test]
    fn remote_peer_without_host_is_not_local() {
        let h = HeaderMap::new();
        assert!(!is_local_request(&h, addr("192.168.1.20:5000")));
    }
}
