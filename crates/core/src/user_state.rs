//! Per-account user state with optimistic revision locking.

use crate::state::AppState;
use crate::sync::LockRecover;
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateV1 {
    pub version: u32,
    pub revision: u64,
    #[serde(default)]
    pub play_counts: serde_json::Map<String, Value>,
    #[serde(default)]
    pub recent_rel_paths: Vec<String>,
    #[serde(default)]
    pub track_moods: serde_json::Map<String, Value>,
    #[serde(default)]
    pub excluded_rel_paths: Vec<String>,
    #[serde(default)]
    pub excluded_album_ids: Vec<i64>,
    #[serde(default)]
    pub settings: serde_json::Map<String, Value>,
}

impl Default for UserStateV1 {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            play_counts: serde_json::Map::new(),
            recent_rel_paths: Vec::new(),
            track_moods: serde_json::Map::new(),
            excluded_rel_paths: Vec::new(),
            excluded_album_ids: Vec::new(),
            settings: serde_json::Map::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountQuery {
    account_id: Option<String>,
}

/// Validated request account: malformed → 400, unknown → 404.
#[allow(clippy::result_large_err)]
fn request_account(
    data_dir: &Path,
    headers: &HeaderMap,
    q: &AccountQuery,
) -> Result<String, Response> {
    crate::accounts::account_from_request(data_dir, headers, q.account_id.as_deref())
        .map_err(|e| err(e.status(), e.code()))
}

/// Path component for an account id. Handlers validate ids strictly first;
/// this only guarantees that no id can ever leave `accounts/`.
fn account_component(account: &str) -> String {
    let t = account.trim();
    if crate::accounts::is_valid_account_id(t) {
        return t.to_string();
    }
    let safe: String = t
        .chars()
        .take(crate::accounts::MAX_ACCOUNT_ID_LEN)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "_invalid".into()
    } else {
        safe
    }
}

pub fn user_state_path(data_dir: &std::path::Path, account: &str) -> PathBuf {
    account_info_dir(data_dir, account).join("user-state.json")
}

const THEME_BG_BASENAME: &str = "theme-bg";
const THEME_BG_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
/// Aligned with legacy `THEME_BG_MAX_BYTES` (32 MiB).
pub const THEME_BG_MAX_BYTES: usize = 32 * 1024 * 1024;
/// Request body cap for the upload route (image + multipart envelope).
const THEME_BG_BODY_LIMIT: usize = THEME_BG_MAX_BYTES + 1024 * 1024;

pub fn account_info_dir(data_dir: &std::path::Path, account: &str) -> PathBuf {
    data_dir
        .join("accounts")
        .join(format!("{}_info", account_component(account)))
}

/// Default path used when the extension is unknown (jpg). Prefer `find_theme_bg_path`.
pub fn theme_bg_path(data_dir: &std::path::Path, account: &str) -> PathBuf {
    theme_bg_path_for_ext(data_dir, account, "jpg")
}

pub fn theme_bg_path_for_ext(data_dir: &std::path::Path, account: &str, ext: &str) -> PathBuf {
    let normalized = if ext.eq_ignore_ascii_case("jpeg") {
        "jpg"
    } else {
        ext
    };
    account_info_dir(data_dir, account).join(format!("{THEME_BG_BASENAME}.{normalized}"))
}

pub fn find_theme_bg_path(data_dir: &std::path::Path, account: &str) -> Option<PathBuf> {
    let dir = account_info_dir(data_dir, account);
    if !dir.is_dir() {
        return None;
    }
    for ext in THEME_BG_EXTS {
        let normalized = if *ext == "jpeg" { "jpg" } else { *ext };
        let fp = dir.join(format!("{THEME_BG_BASENAME}.{normalized}"));
        if fp.is_file() {
            return Some(fp);
        }
    }
    None
}

fn media_type_for_theme_bg(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn sniff_image_ext(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 4 {
        return None;
    }
    if buf[0] == 0x47 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x38 {
        return Some("gif");
    }
    if buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4e && buf[3] == 0x47 {
        return Some("png");
    }
    if buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some("jpg");
    }
    if buf.len() >= 12
        && buf[0] == 0x52
        && buf[1] == 0x49
        && buf[2] == 0x46
        && buf[3] == 0x46
        && buf[8] == 0x57
        && buf[9] == 0x45
        && buf[10] == 0x42
        && buf[11] == 0x50
    {
        return Some("webp");
    }
    None
}

fn ext_from_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn ext_from_filename(name: &str) -> Option<&'static str> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "webp" => Some("webp"),
        "gif" => Some("gif"),
        _ => None,
    }
}

fn resolve_theme_bg_ext(buf: &[u8], mime: &str, original_name: &str) -> Option<&'static str> {
    sniff_image_ext(buf)
        .or_else(|| ext_from_mime(mime))
        .or_else(|| ext_from_filename(original_name))
}

fn remove_existing_theme_bg(dir: &Path) {
    for ext in THEME_BG_EXTS {
        let normalized = if *ext == "jpeg" { "jpg" } else { *ext };
        let fp = dir.join(format!("{THEME_BG_BASENAME}.{normalized}"));
        let _ = fs::remove_file(fp);
    }
}

pub fn save_theme_bg(
    data_dir: &std::path::Path,
    account: &str,
    buffer: &[u8],
    mime: &str,
    original_name: &str,
) -> anyhow::Result<&'static str> {
    if buffer.is_empty() || buffer.len() > THEME_BG_MAX_BYTES {
        anyhow::bail!(
            "Image file too large (max {} MB)",
            THEME_BG_MAX_BYTES / (1024 * 1024)
        );
    }
    let ext = resolve_theme_bg_ext(buffer, mime, original_name)
        .ok_or_else(|| anyhow::anyhow!("Unsupported image type"))?;
    let dir = account_info_dir(data_dir, account);
    fs::create_dir_all(&dir)?;
    remove_existing_theme_bg(&dir);
    let target = theme_bg_path_for_ext(data_dir, account, ext);
    fs::write(target, buffer)?;
    Ok(ext)
}

pub fn delete_theme_bg(data_dir: &std::path::Path, account: &str) -> bool {
    let dir = account_info_dir(data_dir, account);
    if !dir.is_dir() {
        return false;
    }
    let mut removed = false;
    for ext in THEME_BG_EXTS {
        let normalized = if *ext == "jpeg" { "jpg" } else { *ext };
        let fp = dir.join(format!("{THEME_BG_BASENAME}.{normalized}"));
        if fp.is_file() && fs::remove_file(&fp).is_ok() {
            removed = true;
        }
    }
    removed
}

/// Per-file write lock: check-revision + write must be atomic per account.
fn state_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Read without locking. A file that does not parse is moved aside
/// (`user-state.json.corrupt-<ms>`) instead of being silently replaced.
fn read_state_file(path: &Path) -> UserStateV1 {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), error = %e, "user-state read failed");
            }
            return UserStateV1::default();
        }
    };
    match serde_json::from_str(&raw) {
        Ok(state) => state,
        Err(e) => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let mut aside = path.as_os_str().to_owned();
            aside.push(format!(".corrupt-{stamp}"));
            let aside = PathBuf::from(aside);
            match fs::rename(path, &aside) {
                Ok(()) => tracing::error!(
                    path = %path.display(),
                    moved_to = %aside.display(),
                    error = %e,
                    "corrupt user-state moved aside; starting fresh"
                ),
                Err(re) => tracing::error!(
                    path = %path.display(),
                    error = %e,
                    rename_error = %re,
                    "corrupt user-state could not be moved aside"
                ),
            }
            UserStateV1::default()
        }
    }
}

/// Atomic write: temp file in the same dir, fsync, rename over the target.
fn write_state_file(path: &Path, state: &UserStateV1) -> anyhow::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("user-state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".user-state.{}.tmp", uuid::Uuid::new_v4().simple()));
    let body = serde_json::to_vec_pretty(state)?;
    let res = (|| -> anyhow::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

pub fn load_user_state(data_dir: &std::path::Path, account: &str) -> UserStateV1 {
    let path = user_state_path(data_dir, account);
    let lock = state_lock(&path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    read_state_file(&path)
}

pub fn save_user_state(
    data_dir: &std::path::Path,
    account: &str,
    state: &UserStateV1,
) -> anyhow::Result<()> {
    let path = user_state_path(data_dir, account);
    let lock = state_lock(&path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    write_state_file(&path, state)?;
    crate::events::publish(
        "userState",
        serde_json::json!({ "accountId": account, "revision": state.revision }),
    );
    Ok(())
}

/// Outcome of a guarded read-modify-write.
#[derive(Debug)]
pub enum UpdateOutcome {
    Saved(UserStateV1),
    /// `expectedRevision` did not match: carries the current stored state.
    Conflict(UserStateV1),
}

/// Read-modify-write under the per-account lock. When `expected_revision` is
/// set and differs from the stored revision nothing is written. The revision
/// is bumped by one on every successful write.
pub fn update_user_state(
    data_dir: &std::path::Path,
    account: &str,
    expected_revision: Option<u64>,
    apply: impl FnOnce(&mut UserStateV1),
) -> anyhow::Result<UpdateOutcome> {
    let path = user_state_path(data_dir, account);
    let lock = state_lock(&path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let current = read_state_file(&path);
    if let Some(expected) = expected_revision {
        if expected != current.revision {
            return Ok(UpdateOutcome::Conflict(current));
        }
    }
    let revision = current.revision;
    let mut next = current;
    apply(&mut next);
    next.version = 1;
    next.revision = revision.saturating_add(1);
    next.track_moods =
        crate::track_moods::normalize_track_moods_map(std::mem::take(&mut next.track_moods));
    write_state_file(&path, &next)?;
    crate::events::publish(
        "userState",
        serde_json::json!({ "accountId": account, "revision": next.revision }),
    );
    Ok(UpdateOutcome::Saved(next))
}

fn normalize_rel_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.starts_with('/') {
        s = s[1..].to_string();
    }
    s = s.replace("/Tracce/", "/Tracks/");
    if s.starts_with("Tracce/") {
        s = format!("Tracks/{}", &s["Tracce/".len()..]);
    }
    s
}

/// Convert legacy hub `user-state.json` into next `UserStateV1`.
/// Album excludes that are still string keys stay in `settings.legacyExcludedAlbumKeys`
/// until the caller remaps them after a library scan.
pub fn user_state_from_legacy_json(raw: &str) -> anyhow::Result<UserStateV1> {
    let v: Value = serde_json::from_str(raw)?;
    let mut out = UserStateV1 {
        version: 1,
        revision: v
            .get("revision")
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
            .max(1),
        ..Default::default()
    };

    if let Some(obj) = v.get("trackPlayCounts").and_then(|x| x.as_object()) {
        for (k, n) in obj {
            let path = normalize_rel_path(k);
            if path.is_empty() {
                continue;
            }
            if let Some(num) = n.as_f64() {
                if num > 0.0 {
                    out.play_counts
                        .insert(path, Value::from(num.floor() as u64));
                }
            }
        }
    }

    if let Some(arr) = v.get("recent").and_then(|x| x.as_array()) {
        for item in arr {
            let rel = item
                .get("relPath")
                .or_else(|| item.get("rel_path"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let path = normalize_rel_path(rel);
            if !path.is_empty() {
                out.recent_rel_paths.push(path);
            }
        }
        out.recent_rel_paths.truncate(100);
    }

    if let Some(obj) = v.get("trackMoods").and_then(|x| x.as_object()) {
        for (k, moods) in obj {
            let path = normalize_rel_path(k);
            if path.is_empty() {
                continue;
            }
            if let Some(arr) = moods.as_array() {
                let list: Vec<Value> = arr
                    .iter()
                    .filter_map(|m| m.as_str().map(|s| Value::String(s.to_string())))
                    .take(3)
                    .collect();
                if !list.is_empty() {
                    out.track_moods.insert(path, Value::Array(list));
                }
            }
        }
    }

    if let Some(arr) = v
        .get("shuffleExcludedTrackRelPaths")
        .and_then(|x| x.as_array())
    {
        for item in arr {
            if let Some(s) = item.as_str() {
                let path = normalize_rel_path(s);
                if !path.is_empty() {
                    out.excluded_rel_paths.push(path);
                }
            }
        }
    }

    let mut settings = serde_json::Map::new();
    if let Some(obj) = v.get("settings").and_then(|x| x.as_object()) {
        settings = obj.clone();
        // Normalize a few keys for the next client.
        if let Some(theme) = settings.get("theme").cloned() {
            settings.insert("theme".into(), theme);
        }
        if let Some(cf) = settings.get("audioCrossfadeSec").cloned() {
            settings.insert("crossfadeSec".into(), cf);
        }
        if let Some(viz) = settings
            .get("vizMode")
            .or_else(|| settings.get("visualizerMode"))
            .cloned()
        {
            settings.insert("visualizerMode".into(), viz);
        }
    }

    if let Some(arr) = v.get("shuffleExcludedAlbumIds").and_then(|x| x.as_array()) {
        let mut keys = Vec::new();
        let mut ids = Vec::new();
        for item in arr {
            if let Some(n) = item.as_i64() {
                ids.push(n);
            } else if let Some(s) = item.as_str() {
                keys.push(Value::String(s.to_string()));
            } else if let Some(n) = item.as_u64() {
                ids.push(n as i64);
            }
        }
        out.excluded_album_ids = ids;
        if !keys.is_empty() {
            settings.insert("legacyExcludedAlbumKeys".into(), Value::Array(keys));
        }
    }

    // Persist queue for client session restore.
    if let Some(q) = v.get("queue") {
        let mut rel_paths = Vec::new();
        let mut current_index = 0u64;
        if let Some(tracks) = q.get("tracks").and_then(|x| x.as_array()) {
            for t in tracks {
                let rel = t
                    .get("relPath")
                    .or_else(|| t.get("rel_path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let path = normalize_rel_path(rel);
                if !path.is_empty() {
                    rel_paths.push(Value::String(path));
                }
            }
            current_index = q.get("currentIndex").and_then(|x| x.as_u64()).unwrap_or(0);
        } else if let Some(tracks) = q.as_array() {
            for t in tracks {
                let rel = t
                    .get("relPath")
                    .or_else(|| t.get("rel_path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let path = normalize_rel_path(rel);
                if !path.is_empty() {
                    rel_paths.push(Value::String(path));
                }
            }
        }
        if !rel_paths.is_empty() {
            settings.insert(
                "legacyQueue".into(),
                json!({
                    "relPaths": rel_paths,
                    "currentIndex": current_index,
                }),
            );
        }
    }

    out.settings = settings;
    Ok(out)
}

fn ok<T: Serialize>(data: T) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = Json(json!({ "ok": false, "error": msg.into() }));
    (status, body).into_response()
}

/// 409 body: the client rebases on `current` and retries.
fn conflict(current: UserStateV1) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "ok": false, "error": "revision_conflict", "current": current })),
    )
        .into_response()
}

fn data_dir_of(state: &AppState) -> PathBuf {
    state.config.lock_or_recover().data_dir.clone()
}

/// Run a user-state update on the blocking pool and map the outcome.
// The error is an axum `Response` handed straight back to the client.
#[allow(clippy::result_large_err)]
async fn run_update(
    data_dir: PathBuf,
    account: String,
    expected_revision: Option<u64>,
    apply: impl FnOnce(&mut UserStateV1) + Send + 'static,
) -> Result<UserStateV1, Response> {
    let res = tokio::task::spawn_blocking(move || {
        update_user_state(&data_dir, &account, expected_revision, apply)
    })
    .await;
    match res {
        Ok(Ok(UpdateOutcome::Saved(next))) => Ok(next),
        Ok(Ok(UpdateOutcome::Conflict(current))) => Err(conflict(current)),
        Ok(Err(e)) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        Err(e) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/user-state",
            get(get_user_state)
                .put(put_user_state)
                .patch(patch_user_state),
        )
        .route(
            "/api/user-state",
            get(get_user_state)
                .put(put_user_state)
                .patch(patch_user_state),
        )
        .route(
            "/api/v1/user-state/custom-theme-bg",
            get(get_custom_theme_bg)
                .post(post_custom_theme_bg)
                .delete(delete_custom_theme_bg)
                .layer(DefaultBodyLimit::max(THEME_BG_BODY_LIMIT)),
        )
        .route(
            "/api/user-state/custom-theme-bg",
            get(get_custom_theme_bg)
                .post(post_custom_theme_bg)
                .delete(delete_custom_theme_bg)
                .layer(DefaultBodyLimit::max(THEME_BG_BODY_LIMIT)),
        )
}

async fn get_user_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match tokio::task::spawn_blocking(move || load_user_state(&data_dir, &account)).await {
        Ok(s) => ok(s),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutBody {
    expected_revision: Option<u64>,
    state: UserStateV1,
}

async fn put_user_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
    Json(body): Json<PutBody>,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let replacement = body.state;
    match run_update(data_dir, account, body.expected_revision, move |cur| {
        *cur = replacement;
    })
    .await
    {
        Ok(next) => ok(next),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchBody {
    expected_revision: Option<u64>,
    #[serde(default)]
    play_counts: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    recent_rel_paths: Option<Vec<String>>,
    #[serde(default)]
    track_moods: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    excluded_rel_paths: Option<Vec<String>>,
    #[serde(default)]
    excluded_album_ids: Option<Vec<i64>>,
    #[serde(default)]
    settings: Option<serde_json::Map<String, Value>>,
}

/// Partial update. `expectedRevision` is optional (older clients omit it);
/// when present a stale revision yields 409 `revision_conflict` + `current`.
async fn patch_user_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
    Json(body): Json<PatchBody>,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    // Queue/cursor and browse/sort prefs change on every listen: not worth an
    // activity-log line each time.
    const QUIET_SETTINGS: &[&str] = &[
        "queue",
        "queueCursor",
        "legacyQueue",
        "libBrowse",
        "libOverviewSort",
        "artistAlbumSort",
    ];
    let settings_touched = body
        .settings
        .as_ref()
        .is_some_and(|m| m.keys().any(|k| !QUIET_SETTINGS.contains(&k.as_str())));
    let expected = body.expected_revision;
    let res = run_update(
        data_dir.clone(),
        account.clone(),
        expected,
        move |current| {
            if let Some(v) = body.play_counts {
                current.play_counts = v;
            }
            if let Some(v) = body.recent_rel_paths {
                current.recent_rel_paths = v;
            }
            if let Some(v) = body.track_moods {
                current.track_moods = v;
            }
            if let Some(v) = body.excluded_rel_paths {
                current.excluded_rel_paths = v;
            }
            if let Some(v) = body.excluded_album_ids {
                current.excluded_album_ids = v;
            }
            if let Some(v) = body.settings {
                // Merge keys so a partial settings patch cannot wipe theme/locale/etc.
                for (k, val) in v {
                    current.settings.insert(k, val);
                }
            }
        },
    )
    .await;
    match res {
        Ok(next) => {
            if settings_touched {
                crate::diagnostics::log_activity(
                    &data_dir,
                    crate::diagnostics::ActivityEvent::new(
                        "settings",
                        "updated",
                        "settings updated",
                    )
                    .account(Some(&account)),
                );
            }
            ok(next)
        }
        Err(r) => r,
    }
}

async fn get_custom_theme_bg(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let Some(path) = find_theme_bg_path(&data_dir, &account) else {
        return err(StatusCode::NOT_FOUND, "Custom theme background not found");
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut res = bytes.into_response();
            let headers = res.headers_mut();
            if let Ok(ct) = HeaderValue::from_str(media_type_for_theme_bg(&path)) {
                headers.insert(header::CONTENT_TYPE, ct);
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=3600"),
            );
            res
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn post_custom_theme_bg(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
    mut multipart: Multipart,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let mut file_bytes: Option<bytes::Bytes> = None;
    let mut content_type = String::new();
    let mut original_name = String::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name != "file" {
            continue;
        }
        content_type = field.content_type().unwrap_or("").to_string();
        original_name = field.file_name().unwrap_or("").to_string();
        match field.bytes().await {
            Ok(b) => file_bytes = Some(b),
            Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
        }
    }
    let Some(bytes) = file_bytes else {
        return err(StatusCode::BAD_REQUEST, "Missing or empty image file");
    };
    if bytes.len() > THEME_BG_MAX_BYTES {
        return err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Image file too large (max {} MB)",
                THEME_BG_MAX_BYTES / (1024 * 1024)
            ),
        );
    }
    let saved = tokio::task::spawn_blocking(move || {
        save_theme_bg(&data_dir, &account, &bytes, &content_type, &original_name)
    })
    .await
    .unwrap_or_else(|e| Err(anyhow::anyhow!(e.to_string())));
    match saved {
        Ok(bg_image) => {
            let rev = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(1);
            ok(json!({ "bgImage": bg_image, "bgImageRev": rev }))
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Unsupported image type") {
                err(StatusCode::BAD_REQUEST, msg)
            } else if msg.contains("too large") {
                err(StatusCode::PAYLOAD_TOO_LARGE, msg)
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        }
    }
}

async fn delete_custom_theme_bg(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccountQuery>,
) -> Response {
    let data_dir = data_dir_of(&state);
    let account = match request_account(&data_dir, &headers, &q) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let _ = tokio::task::spawn_blocking(move || delete_theme_bg(&data_dir, &account)).await;
    ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("rekord-user-state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn traversal_ids_stay_inside_accounts_dir() {
        let dir = temp_dir();
        let p = user_state_path(&dir, "../../x");
        assert!(p.starts_with(dir.join("accounts")));
        assert!(!p.to_string_lossy().contains(".."));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_revision_conflicts_and_writes_nothing() {
        let dir = temp_dir();
        let first = update_user_state(&dir, "default", None, |s| {
            s.recent_rel_paths = vec!["A/B/01.mp3".into()];
        })
        .unwrap();
        let UpdateOutcome::Saved(first) = first else {
            panic!("expected save")
        };
        assert_eq!(first.revision, 1);
        let out =
            update_user_state(&dir, "default", Some(0), |s| s.recent_rel_paths.clear()).unwrap();
        match out {
            UpdateOutcome::Conflict(cur) => assert_eq!(cur.recent_rel_paths.len(), 1),
            UpdateOutcome::Saved(_) => panic!("expected conflict"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = temp_dir();
        let path = user_state_path(&dir, "default");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        let s = load_user_state(&dir, "default");
        assert_eq!(s.revision, 0);
        let aside = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("user-state.json.corrupt-")
            });
        assert!(aside, "corrupt copy kept for recovery");
        let _ = fs::remove_dir_all(&dir);
    }
}
