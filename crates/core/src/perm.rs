//! Permissions for host-level operations.
//!
//! Two levels (parity legacy `requestAccess.mjs:61-99`, where a loopback
//! request may run every server mutation):
//!
//! - **Library operation** — Studio / library writes (downloads, folders,
//!   tags, covers, curiosità). Allowed to *any* account on a local request
//!   (same machine, no proxy/tunnel headers, allowed origin); a remote client
//!   needs `allow_remote_admin`.
//! - **Machine operation** — touches the host itself: credentials (cookies,
//!   Discogs token), library path, restore, tunnel, remote-admin toggle, tool
//!   updates. Requires the Default account and, unless `allow_remote_admin` is
//!   set, a local client.
//!
//! Refusals are 403 with a stable code: `forbidden_remote` (not local and
//! remote admin off) or `forbidden_default_account` (machine operation from
//! another account). Remote clients (APK, LAN) stay fully functional for
//! personal data.

use crate::accounts;
use crate::state::AppState;
use crate::sync::LockRecover;
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
///
/// A request carrying a foreign browser origin (any web page open on the hub
/// machine) is never local, even from loopback.
pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    if PROXY_HEADERS.iter().any(|h| headers.contains_key(*h)) {
        return false;
    }
    if crate::origin::classify(headers) == crate::origin::OriginKind::Foreign {
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

/// 403: not on the hub machine and remote admin is off.
pub const FORBIDDEN_REMOTE: &str = "forbidden_remote";
/// 403: machine operation from an account other than Default.
pub const FORBIDDEN_DEFAULT_ACCOUNT: &str = "forbidden_default_account";

/// 403 envelope with a stable code (and an English hint for logs).
pub fn forbidden(code: &'static str) -> Response {
    let message = match code {
        FORBIDDEN_REMOTE => {
            "only available from the hub computer (or enable remote access in the hub panel)"
        }
        FORBIDDEN_DEFAULT_ACCOUNT => "only the Default account can run machine operations",
        _ => "forbidden",
    };
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "ok": false, "data": null, "error": code, "message": message })),
    )
        .into_response()
}

/// Authorise a machine operation, or produce the 403 response to return.
#[allow(clippy::result_large_err)]
pub fn require_machine_op(
    state: &AppState,
    headers: &HeaderMap,
    query_account_id: Option<&str>,
    peer: Option<SocketAddr>,
) -> Result<MachineOp, Response> {
    let (data_dir, allow_remote) = {
        let cfg = state.config.lock_or_recover();
        (cfg.data_dir.clone(), cfg.allow_remote_admin)
    };
    let local = is_local_request(headers, peer);
    if !local && !allow_remote {
        return Err(forbidden(FORBIDDEN_REMOTE));
    }
    let account_id = accounts::require_default_account(&data_dir, headers, query_account_id)
        .map_err(|_| forbidden(FORBIDDEN_DEFAULT_ACCOUNT))?;
    Ok(MachineOp { account_id, local })
}

/// Authorise a library / Studio write: any account from the hub machine; a
/// remote client only with `allow_remote_admin`.
#[allow(clippy::result_large_err)]
pub fn require_library_op(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<bool, Response> {
    let allow_remote = state.config.lock_or_recover().allow_remote_admin;
    let local = is_local_request(headers, peer);
    if !local && !allow_remote {
        return Err(forbidden(FORBIDDEN_REMOTE));
    }
    Ok(local)
}

/// Host-level access without the Default-account requirement (account
/// registry management). Same rule as [`require_library_op`].
#[allow(clippy::result_large_err)]
pub fn require_host_op(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<bool, Response> {
    require_library_op(state, headers, peer)
}

/// Describe the caller's rights so the client can gate controls:
/// `canManageLibrary` (Studio / library writes) and `canManageMachine`
/// (credentials, library path, restore, tunnel, tool updates).
pub fn machine_op_status(
    state: &AppState,
    headers: &HeaderMap,
    query_account_id: Option<&str>,
    peer: Option<SocketAddr>,
) -> serde_json::Value {
    let (data_dir, allow_remote) = {
        let cfg = state.config.lock_or_recover();
        (cfg.data_dir.clone(), cfg.allow_remote_admin)
    };
    let is_default =
        accounts::require_default_account(&data_dir, headers, query_account_id).is_ok();
    let local = is_local_request(headers, peer);
    let reachable = local || allow_remote;
    let machine_reason = if !reachable {
        Some(FORBIDDEN_REMOTE)
    } else if !is_default {
        Some(FORBIDDEN_DEFAULT_ACCOUNT)
    } else {
        None
    };
    json!({
        "isDefaultAccount": is_default,
        "local": local,
        "allowRemoteAdmin": allow_remote,
        "canManageLibrary": reachable,
        "canManageMachine": is_default && reachable,
        "libraryDeniedReason": if reachable { None } else { Some(FORBIDDEN_REMOTE) },
        "machineDeniedReason": machine_reason,
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
    fn foreign_origin_from_loopback_is_not_local() {
        let h = headers(&[
            ("host", "127.0.0.1:7420"),
            ("origin", "https://evil.example"),
        ]);
        assert!(!is_local_request(&h, addr("127.0.0.1:5000")));
        let h = headers(&[("host", "127.0.0.1:7420"), ("origin", "tauri://localhost")]);
        assert!(is_local_request(&h, addr("127.0.0.1:5000")));
        let h = headers(&[("host", "127.0.0.1:7420"), ("sec-fetch-site", "cross-site")]);
        assert!(!is_local_request(&h, addr("127.0.0.1:5000")));
    }

    #[test]
    fn remote_peer_without_host_is_not_local() {
        let h = HeaderMap::new();
        assert!(!is_local_request(&h, addr("192.168.1.20:5000")));
    }
}
