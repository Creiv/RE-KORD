//! Diagnostics and activity log.

use crate::accounts;
use crate::perm::PeerAddr;
use crate::state::AppState;
use crate::sync::LockRecover;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

static STARTED_AT: OnceLock<Instant> = OnceLock::new();

const DEFAULT_ACTIVITY_LIMIT: usize = 500;
const MAX_ACTIVITY_LIMIT: usize = 2000;

pub fn mark_started() {
    let _ = STARTED_AT.set(Instant::now());
}

fn ok<T: Serialize>(data: T) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

/// Append a system-level activity line (no account).
pub fn append_activity(data_dir: &std::path::Path, kind: &str, message: &str) {
    append_activity_with_account(data_dir, kind, message, None);
}

/// Append an activity line. When `account_id` is set, the JSONL entry includes `accountId`.
///
/// Schema (JSONL line):
/// ```json
/// { "ts": "...", "kind": "...", "message": "...", "accountId": "optional" }
/// ```
pub fn append_activity_with_account(
    data_dir: &std::path::Path,
    kind: &str,
    message: &str,
    account_id: Option<&str>,
) {
    write_activity(data_dir, kind, None, Value::Null, message, account_id);
}

/// One activity event the panels can translate: `code` is `"{kind}.{action}"`
/// and `params` fills the placeholders of the translated text. `message`
/// stays the plain text older clients show.
pub struct ActivityEvent<'a> {
    pub kind: &'a str,
    pub action: &'a str,
    pub params: Value,
    pub message: String,
    pub account_id: Option<&'a str>,
}

impl<'a> ActivityEvent<'a> {
    pub fn new(kind: &'a str, action: &'a str, message: impl Into<String>) -> Self {
        Self {
            kind,
            action,
            params: Value::Null,
            message: message.into(),
            account_id: None,
        }
    }

    pub fn params(mut self, params: Value) -> Self {
        self.params = params;
        self
    }

    pub fn account(mut self, account_id: Option<&'a str>) -> Self {
        self.account_id = account_id;
        self
    }
}

/// Append a coded activity line.
///
/// Schema (JSONL line):
/// ```json
/// { "ts": "...", "kind": "scan", "action": "started", "code": "scan.started",
///   "params": { "mode": "full" }, "message": "library scan started (full)" }
/// ```
pub fn log_activity(data_dir: &std::path::Path, event: ActivityEvent<'_>) {
    write_activity(
        data_dir,
        event.kind,
        Some(event.action),
        event.params,
        &event.message,
        event.account_id,
    );
}

fn write_activity(
    data_dir: &std::path::Path,
    kind: &str,
    action: Option<&str>,
    params: Value,
    message: &str,
    account_id: Option<&str>,
) {
    let path = data_dir.join("activity.jsonl");
    let _ = fs::create_dir_all(data_dir);
    let mut obj = Map::new();
    obj.insert("ts".into(), json!(chrono::Utc::now().to_rfc3339()));
    obj.insert("kind".into(), json!(kind));
    if let Some(action) = action {
        obj.insert("action".into(), json!(action));
        obj.insert("code".into(), json!(format!("{kind}.{action}")));
        if params.is_object() {
            obj.insert("params".into(), params);
        }
    }
    obj.insert("message".into(), json!(message));
    if let Some(id) = account_id.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("accountId".into(), json!(id));
    }
    let line = Value::Object(obj);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/diagnostics", get(diagnostics))
        .route("/api/diagnostics", get(diagnostics))
        .route(
            "/api/v1/diagnostics/errors",
            get(recent_errors).delete(clear_errors),
        )
        .route("/api/v1/activity-log", get(activity_log))
        .route("/api/activity-log", get(activity_log))
}

async fn diagnostics(State(state): State<AppState>) -> Response {
    let _ = STARTED_AT.get_or_init(Instant::now);
    let uptime_secs = STARTED_AT.get().map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let cfg = state.config.lock_or_recover().clone();
    let stats = state.db.stats(None).ok();
    let disk = cfg
        .music_root
        .as_ref()
        .and_then(|root| crate::disk_space::volume_space(root))
        .map(|space| {
            json!({
                "totalBytes": space.total_bytes,
                "availableBytes": space.available_bytes,
            })
        });
    let db_bytes = std::fs::metadata(cfg.db_path()).map(|m| m.len()).ok();
    let layout = cfg
        .music_root
        .as_ref()
        .map(|root| crate::layout::load_layout(root));
    // Removals the scan guard held back, and user links waiting for their file.
    let last_prune_skipped = state
        .db
        .get_meta("last_prune_skipped")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let (parked_favorites, parked_playlist_tracks) =
        state.db.parked_user_link_counts().unwrap_or((0, 0));
    // Tool versions: cached (10 min), probed off the async workers.
    let ctx = crate::tools::ToolContext::from_config(&cfg);
    let (ytdlp, ffmpeg, ffprobe, cloudflared, js_runtime) = tokio::join!(
        crate::tools::resolve(crate::tools::Tool::Ytdlp, &ctx),
        crate::tools::resolve(crate::tools::Tool::Ffmpeg, &ctx),
        crate::tools::resolve(crate::tools::Tool::Ffprobe, &ctx),
        crate::tools::resolve(crate::tools::Tool::Cloudflared, &ctx),
        crate::js_runtime::resolve(),
    );

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
            "sizeBytes": db_bytes,
        },
        "library": {
            "lastPruneSkipped": last_prune_skipped,
            "parkedFavorites": parked_favorites,
            "parkedPlaylistTracks": parked_playlist_tracks,
        },
        "activeDownloads": state.active_downloads.lock_or_recover().len(),
        "jobs": {
            "active": state.jobs.active_count(),
            "recent": state.jobs.list().into_iter().take(10).collect::<Vec<_>>(),
        },
        "watcher": state.watcher.status(cfg.watch_library),
        "binaries": {
            "ytdlp": crate::tools::status_json(&ytdlp),
            "ffmpeg": crate::tools::status_json(&ffmpeg),
            "ffprobe": crate::tools::status_json(&ffprobe),
            "cloudflared": crate::tools::status_json(&cloudflared),
            "jsRuntime": crate::js_runtime::status_json(&js_runtime),
        },
        "versionCacheTtlSecs": crate::tools::VERSION_TTL.as_secs(),
        "layout": layout,
        "disk": disk,
        "errors": {
            "count": crate::errors::count(),
            "recent": crate::errors::recent(20),
        },
        "allowRemoteAdmin": cfg.allow_remote_admin,
    }))
}

#[derive(Debug, Deserialize, Default)]
struct ErrorsQuery {
    limit: Option<usize>,
}

async fn recent_errors(Query(q): Query<ErrorsQuery>) -> Response {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    ok(json!({ "entries": crate::errors::recent(limit), "count": crate::errors::count() }))
}

async fn clear_errors(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<ActivityLogQuery>,
) -> Response {
    if let Err(r) = crate::perm::require_machine_op(&state, &headers, q.account_id.as_deref(), peer)
    {
        return r;
    }
    crate::errors::clear();
    ok(json!({ "cleared": true }))
}

#[derive(Debug, Deserialize, Default)]
struct ActivityLogQuery {
    /// Caller identity (also accepted via `X-KORD-Account-Id` / `X-REKORD-Account-Id`).
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    /// Calendar day `YYYY-MM-DD` (server local timezone). Default account only.
    day: Option<String>,
    /// RFC3339 lower bound. Clamped to last 24h for non-default callers.
    since: Option<String>,
    /// `all` (default) | `system` | `user`. Default account only; ignored otherwise.
    scope: Option<String>,
    /// When set, only entries for this account id (implies user events). Default only.
    #[serde(rename = "filterAccountId")]
    filter_account_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivityScope {
    All,
    System,
    User,
}

fn parse_scope(raw: Option<&str>) -> ActivityScope {
    match raw
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "system" | "sys" => ActivityScope::System,
        "user" | "users" | "account" | "accounts" => ActivityScope::User,
        _ => ActivityScope::All,
    }
}

fn account_id_from_entry(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    for key in ["accountId", "account_id"] {
        if let Some(s) = obj.get(key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn entry_ts(entry: &Value) -> Option<DateTime<Utc>> {
    let s = entry.get("ts")?.as_str()?;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
        .or_else(|| {
            // Tolerate timestamps without offset (treat as UTC).
            DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        })
}

fn local_day_bounds(day: &str) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let naive = NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d").ok()?;
    let start_naive = naive.and_hms_opt(0, 0, 0)?;
    let next = naive.succ_opt()?;
    let end_naive = next.and_hms_opt(0, 0, 0)?;
    let start_local = Local
        .from_local_datetime(&start_naive)
        .single()
        .or_else(|| Local.from_local_datetime(&start_naive).earliest())?;
    let end_local = Local
        .from_local_datetime(&end_naive)
        .single()
        .or_else(|| Local.from_local_datetime(&end_naive).earliest())?;
    Some((
        start_local.with_timezone(&Utc),
        end_local.with_timezone(&Utc),
    ))
}

fn resolve_time_window(
    is_default: bool,
    day: Option<&str>,
    since_raw: Option<&str>,
) -> (DateTime<Utc>, DateTime<Utc>, Option<String>) {
    let now = Utc::now();
    let floor_24h = now - Duration::hours(24);

    if !is_default {
        // Non-default accounts: always last 24 hours (ignore day / older since).
        return (floor_24h, now, None);
    }

    if let Some(d) = day.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((start, end)) = local_day_bounds(d) {
            return (start, end, Some(d.to_string()));
        }
    }

    if let Some(s) = since_raw.map(str::trim).filter(|v| !v.is_empty()) {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(s) {
            let since = parsed.with_timezone(&Utc);
            return (since, now, None);
        }
    }

    // Default with no day/since: today (local calendar day).
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    if let Some((start, end)) = local_day_bounds(&today) {
        return (start, end, Some(today));
    }
    (floor_24h, now, None)
}

fn scope_label(scope: ActivityScope) -> &'static str {
    match scope {
        ActivityScope::All => "all",
        ActivityScope::System => "system",
        ActivityScope::User => "user",
    }
}

async fn activity_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ActivityLogQuery>,
) -> Response {
    let data_dir = state.config.lock_or_recover().data_dir.clone();
    // Unknown / malformed ids are refused instead of falling back to Default
    // (which would unlock the full log).
    let caller_id =
        match accounts::account_from_request(&data_dir, &headers, q.account_id.as_deref()) {
            Ok(id) => id,
            Err(e) => {
                return (e.status(), Json(json!({ "ok": false, "error": e.code() })))
                    .into_response()
            }
        };
    let is_default = accounts::is_default_account_id(&caller_id);
    let can_select_day = is_default;

    // Source filters (`scope` / `filterAccountId`) are Default-only.
    // Non-default callers always see the last 24h with scope=all.
    let (effective_scope, filter_account_id) = if is_default {
        let scope = parse_scope(q.scope.as_deref());
        let filter_account_id = q
            .filter_account_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        // Specific account filter forces user-scope semantics.
        let effective_scope = if filter_account_id.is_some() && scope == ActivityScope::All {
            ActivityScope::User
        } else {
            scope
        };
        (effective_scope, filter_account_id)
    } else {
        (ActivityScope::All, None)
    };

    let (since, until, day_used) =
        resolve_time_window(is_default, q.day.as_deref(), q.since.as_deref());

    let limit = q
        .limit
        .unwrap_or(DEFAULT_ACTIVITY_LIMIT)
        .clamp(1, MAX_ACTIVITY_LIMIT);

    let path = data_dir.join("activity.jsonl");
    let raw = fs::read_to_string(path).unwrap_or_default();
    // Newest first: scan from the end and stop at `limit`.
    let mut entries: Vec<Value> = Vec::new();
    for line in raw.lines().rev() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = entry_ts(&entry) else {
            continue;
        };
        if ts < since || ts >= until {
            continue;
        }
        let entry_account = account_id_from_entry(&entry);
        match effective_scope {
            ActivityScope::System => {
                if entry_account.is_some() {
                    continue;
                }
            }
            ActivityScope::User => {
                let Some(ref id) = entry_account else {
                    continue;
                };
                if let Some(ref want) = filter_account_id {
                    if id != want {
                        continue;
                    }
                }
            }
            ActivityScope::All => {
                if let Some(ref want) = filter_account_id {
                    match entry_account {
                        Some(ref id) if id == want => {}
                        _ => continue,
                    }
                }
            }
        }
        entries.push(entry);
        if entries.len() >= limit {
            break;
        }
    }

    let name_by_id: HashMap<String, String> = accounts::ensure_accounts(&data_dir)
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id, a.name))
        .collect();
    for entry in &mut entries {
        let Some(id) = account_id_from_entry(entry) else {
            continue;
        };
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("accountId".into(), json!(id));
            if let Some(name) = name_by_id.get(&id) {
                obj.insert("accountName".into(), json!(name));
            }
        }
    }

    ok(json!({
        "entries": entries,
        "canSelectDay": can_select_day,
        "scope": scope_label(effective_scope),
        "filterAccountId": filter_account_id,
        "window": {
            "since": since.to_rfc3339(),
            "until": until.to_rfc3339(),
            "day": day_used,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scope_aliases() {
        assert_eq!(parse_scope(Some("system")), ActivityScope::System);
        assert_eq!(parse_scope(Some("USER")), ActivityScope::User);
        assert_eq!(parse_scope(Some("all")), ActivityScope::All);
        assert_eq!(parse_scope(None), ActivityScope::All);
    }

    #[test]
    fn non_default_window_is_24h() {
        let (since, until, day) = resolve_time_window(false, Some("2020-01-01"), None);
        assert!(day.is_none());
        let span = until - since;
        assert!(span <= Duration::hours(24) + Duration::seconds(2));
        assert!(span >= Duration::hours(24) - Duration::seconds(2));
    }

    #[test]
    fn default_day_window_uses_local_bounds() {
        let (since, until, day) = resolve_time_window(true, Some("2026-07-15"), None);
        assert_eq!(day.as_deref(), Some("2026-07-15"));
        assert!(until > since);
        let span = until - since;
        assert!(span <= Duration::hours(25));
        assert!(span >= Duration::hours(23));
    }

    #[test]
    fn coded_activity_keeps_the_plain_message_too() {
        let dir = std::env::temp_dir().join(format!("rekord-activity-{}", uuid::Uuid::new_v4()));
        log_activity(
            &dir,
            ActivityEvent::new("scan", "started", "library scan started (full)")
                .params(json!({ "mode": "full" }))
                .account(Some("acc-1")),
        );
        append_activity(&dir, "system", "plain line");
        let raw = fs::read_to_string(dir.join("activity.jsonl")).unwrap();
        let _ = fs::remove_dir_all(&dir);
        let lines: Vec<Value> = raw
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["kind"], "scan");
        assert_eq!(lines[0]["action"], "started");
        assert_eq!(lines[0]["code"], "scan.started");
        assert_eq!(lines[0]["params"], json!({ "mode": "full" }));
        assert_eq!(lines[0]["message"], "library scan started (full)");
        assert_eq!(lines[0]["accountId"], "acc-1");
        assert!(lines[1].get("code").is_none());
        assert_eq!(lines[1]["message"], "plain line");
    }
}
