//! Diagnostics and activity log.

use crate::state::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

static STARTED_AT: OnceLock<Instant> = OnceLock::new();

pub fn mark_started() {
    let _ = STARTED_AT.set(Instant::now());
}

fn ok<T: Serialize>(data: T) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

pub fn append_activity(data_dir: &std::path::Path, kind: &str, message: &str) {
    let path = data_dir.join("activity.jsonl");
    let _ = fs::create_dir_all(data_dir);
    let line = json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "kind": kind,
        "message": message,
    });
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/diagnostics", get(diagnostics))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/v1/activity-log", get(activity_log))
        .route("/api/activity-log", get(activity_log))
}

async fn diagnostics(State(state): State<AppState>) -> Response {
    let _ = STARTED_AT.get_or_init(Instant::now);
    let uptime_secs = STARTED_AT.get().map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let cfg = state.config.lock().unwrap().clone();
    let stats = state.db.stats(None).ok();
    ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeSecs": uptime_secs,
        "musicRoot": cfg.music_root.as_ref().map(|p| p.display().to_string()),
        "dataDir": cfg.data_dir.display().to_string(),
        "scanning": state.is_scanning(),
        "db": {
            "trackCount": stats.as_ref().map(|s| s.track_count).unwrap_or(0),
            "albumCount": stats.as_ref().map(|s| s.album_count).unwrap_or(0),
            "artistCount": stats.as_ref().map(|s| s.artist_count).unwrap_or(0),
            "lastScanAt": stats.as_ref().and_then(|s| s.last_scan_at.clone()),
        },
        "activeDownloads": state.active_downloads.lock().unwrap().len(),
    }))
}

async fn activity_log(State(state): State<AppState>) -> Response {
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let path = data_dir.join("activity.jsonl");
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut entries: Vec<Value> = raw
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if entries.len() > 200 {
        entries = entries.split_off(entries.len() - 200);
    }
    entries.reverse();
    ok(json!({ "entries": entries }))
}

