//! Diagnostics and activity log.

use crate::accounts;
use crate::state::AppState;
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
    let path = data_dir.join("activity.jsonl");
    let _ = fs::create_dir_all(data_dir);
    let mut obj = Map::new();
    obj.insert("ts".into(), json!(chrono::Utc::now().to_rfc3339()));
    obj.insert("kind".into(), json!(kind));
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

/// Probe an external binary for `--version`, returning the first output line.
fn binary_version(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

fn which(bin: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(bin))
        .find(|candidate| candidate.is_file())
}

fn binary_status(explicit: Option<&std::path::Path>, bin: &str) -> Value {
    let resolved = explicit
        .filter(|p| p.is_file())
        .map(|p| p.to_path_buf())
        .or_else(|| which(bin));
    match resolved {
        Some(path) => json!({
            "available": true,
            "path": path.display().to_string(),
            "version": binary_version(&path),
        }),
        None => json!({ "available": false, "path": Value::Null, "version": Value::Null }),
    }
}

async fn diagnostics(State(state): State<AppState>) -> Response {
    let _ = STARTED_AT.get_or_init(Instant::now);
    let uptime_secs = STARTED_AT.get().map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let cfg = state.config.lock().unwrap().clone();
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
        "activeDownloads": state.active_downloads.lock().unwrap().len(),
        "jobs": {
            "active": state.jobs.active_count(),
            "recent": state.jobs.list().into_iter().take(10).collect::<Vec<_>>(),
        },
        "watcher": state.watcher.status(cfg.watch_library),
        "binaries": {
            "ytdlp": binary_status(cfg.ytdlp_path.as_deref(), "yt-dlp"),
            "ffmpeg": binary_status(None, "ffmpeg"),
            "ffprobe": binary_status(None, "ffprobe"),
            "cloudflared": json!({
                "available": crate::remote_access::is_cloudflared_available(),
            }),
        },
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

async fn clear_errors() -> Response {
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
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let requested = accounts::account_id_from_headers_and_query(&headers, q.account_id.as_deref());
    let caller_id = accounts::resolve_account_id(&data_dir, requested.as_deref())
        .unwrap_or_else(|_| accounts::DEFAULT_ACCOUNT_ID.to_string());
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
}
