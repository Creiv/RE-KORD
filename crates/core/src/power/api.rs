//! `GET/PUT /api/v1/system/power` and the request hook that feeds `whenActive`.

use super::{ActivityGuard, ActivityKind};
use crate::config::{PowerSettings, PreventSleep};
use crate::perm::PeerAddr;
use crate::sync::LockRecover;
use crate::AppState;
use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v1/system/power", get(get_power).put(put_power))
}

fn ok(data: Value) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

fn err(status: StatusCode, code: &str, message: Option<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": code, "message": message })),
    )
        .into_response()
}

/// Settings, limits and live status (no side effects).
pub fn payload(state: &AppState) -> Value {
    let (settings, locked) = {
        let cfg = state.config.lock_or_recover();
        (cfg.power, cfg.power_mode_from_env)
    };
    json!({
        "preventSleep": settings.prevent_sleep.as_str(),
        "graceMinutes": settings.grace_minutes,
        "keepAwakeLidClosed": settings.keep_awake_lid_closed,
        "lockedByEnv": locked,
        "platform": std::env::consts::OS,
        "limits": {
            "minGraceMinutes": PowerSettings::MIN_GRACE_MINUTES,
            "maxGraceMinutes": PowerSettings::MAX_GRACE_MINUTES,
            "defaultGraceMinutes": PowerSettings::DEFAULT_GRACE_MINUTES,
        },
        "status": state.power.status(),
    })
}

async fn get_power(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let mut data = payload(&state);
    if let Some(obj) = data.as_object_mut() {
        obj.insert(
            "machineAccess".into(),
            crate::perm::machine_op_status(&state, &headers, None, peer),
        );
    }
    ok(data)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PowerBody {
    prevent_sleep: Option<String>,
    /// Signed: a negative value typed in a form is clamped, not rejected
    /// outside the usual error envelope.
    grace_minutes: Option<i64>,
    keep_awake_lid_closed: Option<bool>,
}

async fn put_power(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<PowerBody>,
) -> Response {
    let op = match crate::perm::require_machine_op(&state, &headers, None, peer) {
        Ok(op) => op,
        Err(r) => return r,
    };
    let mode = match body.prevent_sleep.as_deref().map(PreventSleep::parse) {
        Some(None) => {
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_prevent_sleep",
                Some("preventSleep must be off, always or whenActive".into()),
            )
        }
        Some(Some(m)) => Some(m),
        None => None,
    };
    let (before, next, data_dir, was_inhibiting) = {
        let mut cfg = state.config.lock_or_recover();
        let before = cfg.power;
        if cfg.power_mode_from_env && mode.is_some_and(|m| m != before.prevent_sleep) {
            return err(
                StatusCode::CONFLICT,
                "power_locked_by_env",
                Some("REKORD_PREVENT_SLEEP / --prevent-sleep sets the mode".into()),
            );
        }
        let mut next = before;
        if let Some(m) = mode {
            next.prevent_sleep = m;
        }
        if let Some(g) = body.grace_minutes {
            next.grace_minutes = g.clamp(0, i64::from(u32::MAX)) as u32;
        }
        if let Some(l) = body.keep_awake_lid_closed {
            next.keep_awake_lid_closed = l;
        }
        if let Err(e) = cfg.save_power_settings(next) {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "settings_save_failed",
                Some(e.to_string()),
            );
        }
        // Applied under the config lock: two concurrent changes cannot leave
        // the manager running one and the file saying the other.
        let was_inhibiting = state.power.status().inhibiting;
        state.power.configure(cfg.power);
        (before, cfg.power, cfg.data_dir.clone(), was_inhibiting)
    };
    if next != before {
        crate::diagnostics::log_activity(
            &data_dir,
            crate::diagnostics::ActivityEvent::new(
                "power",
                "settings",
                format!(
                    "prevent sleep: {} (grace {} min, lid {})",
                    next.prevent_sleep.as_str(),
                    next.grace_minutes,
                    if next.keep_awake_lid_closed {
                        "on"
                    } else {
                        "off"
                    }
                ),
            )
            .params(json!({
                "mode": next.prevent_sleep.as_str(),
                "graceMinutes": next.grace_minutes,
                "lid": next.keep_awake_lid_closed,
            }))
            .account(Some(&op.account_id)),
        );
    }
    // A platform that refuses the lock does so within moments: answer with
    // that outcome instead of a lock that is about to vanish.
    if !was_inhibiting && state.power.status().inhibiting {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let mut data = payload(&state);
    if let Some(obj) = data.as_object_mut() {
        obj.insert(
            "machineAccess".into(),
            crate::perm::machine_op_status(&state, &headers, None, peer),
        );
    }
    ok(data)
}

/// Streaming routes whose response body counts as activity while it is sent.
fn is_stream_path(path: &str) -> bool {
    path.starts_with("/media/")
        || path.starts_with("/api/v1/media/")
        || path.starts_with("/api/v1/transcode/")
        || path.starts_with("/api/v1/podcasts/play/")
        || path.starts_with("/api/v1/catalog-web-preview/stream")
        || path.starts_with("/api/catalog-web-preview/stream")
}

/// Status probes clients repeat on their own: they do not mean "in use".
fn is_probe_path(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/health"
            | "/api/health"
            | "/api/v1/system/power"
            | "/api/v1/remote-access"
            | "/api/remote-access"
    )
}

/// A request that came through the Cloudflare tunnel.
fn through_tunnel(headers: &HeaderMap) -> bool {
    headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip")
}

/// Middleware: with `whenActive` on, streams hold an activity open until their
/// body is sent and tunnel requests refresh the grace period. Otherwise it is
/// a single atomic load.
pub async fn activity_layer(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if !state.power.when_active() {
        return next.run(req).await;
    }
    let path = req.uri().path();
    let stream = req.method() == Method::GET && is_stream_path(path);
    if !stream {
        if through_tunnel(req.headers()) && !is_probe_path(path) {
            state.power.touch(ActivityKind::Remote);
        }
        return next.run(req).await;
    }
    let guard = state.power.begin(ActivityKind::Stream);
    let res = next.run(req).await;
    if !res.status().is_success() {
        return res;
    }
    res.map(|inner| {
        Body::new(GuardedBody {
            inner,
            _guard: guard,
        })
    })
}

/// A response body that keeps an activity open until it is done or dropped
/// (the client went away).
struct GuardedBody {
    inner: Body,
    _guard: ActivityGuard,
}

impl HttpBody for GuardedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.get_mut().inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_and_probe_paths() {
        assert!(is_stream_path("/media/A/B/01.flac"));
        assert!(is_stream_path("/api/v1/transcode/A/B/01.wma"));
        assert!(is_stream_path("/api/v1/podcasts/play/3/abc"));
        assert!(is_stream_path("/api/v1/catalog-web-preview/stream"));
        assert!(!is_stream_path("/api/v1/library"));
        assert!(is_probe_path("/api/v1/health"));
        assert!(!is_probe_path("/api/v1/user-state"));
    }
}
