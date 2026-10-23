//! HTTP endpoints of the podcasts module (`/api/v1/podcasts…`).
//!
//! Client endpoints (list, play, artwork) answer 404 `podcasts_disabled`
//! while the module is off. The admin endpoints (`/api/v1/podcasts/admin…`)
//! stay reachable so the module can be configured and switched on; writes
//! are machine operations.

use super::detect::{detect, Detected};
use super::proxy::{self, error_response};
use super::store::{self, NewSource, Source, SourceKind};
use super::{
    enabled, refresh_source, PodcastError, DEFAULT_EPISODE_COUNT, LIVE_KEY, MAX_EPISODE_COUNT,
    MAX_SOURCES,
};
use crate::config::PodcastSettings;
use crate::perm::PeerAddr;
use crate::sync::LockRecover;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// A list request waits at most this long for stale sources; slower fetches
/// finish anyway and show up at the next open.
const LIST_WAIT: Duration = Duration::from_secs(25);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/podcasts", get(list_sources))
        .route("/api/v1/podcasts/sources/{id}", get(get_source))
        .route("/api/v1/podcasts/play/{id}/{key}", get(play))
        .route("/api/v1/podcasts/art/{id}/{key}", get(art))
        .route("/api/v1/podcasts/admin", get(admin_get))
        .route("/api/v1/podcasts/admin/settings", put(admin_settings))
        .route("/api/v1/podcasts/admin/test", post(admin_test))
        .route("/api/v1/podcasts/admin/sources", post(admin_add))
        .route(
            "/api/v1/podcasts/admin/sources/{id}",
            put(admin_update).delete(admin_delete),
        )
        .route("/api/v1/podcasts/admin/order", put(admin_order))
}

fn ok(data: Value) -> Response {
    Json(json!({ "ok": true, "data": data, "error": null })).into_response()
}

fn rfc3339(ts: Option<i64>) -> Option<String> {
    ts.and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// What clients see of a source: no upstream URLs.
pub fn source_view(src: &Source, admin: bool) -> Value {
    let source_art = src.artwork_url.is_some();
    let episodes: Vec<Value> = if src.kind == SourceKind::Live {
        vec![json!({
            "key": LIVE_KEY,
            "title": src.name,
            "live": true,
            "hasArt": source_art,
        })]
    } else {
        src.episodes
            .iter()
            .take(src.episode_count as usize)
            .map(|e| {
                json!({
                    "key": e.key,
                    "title": e.title,
                    "publishedAt": e.published_at,
                    "durationSecs": e.duration_secs,
                    "hasArt": e.artwork_url.is_some() || source_art,
                    "mime": e.mime,
                    "live": false,
                })
            })
            .collect()
    };
    let mut v = json!({
        "id": src.id,
        "name": src.name,
        "kind": src.kind.as_str(),
        "live": src.kind == SourceKind::Live,
        "episodeCount": src.episode_count,
        "hasArt": source_art || src.episodes.iter().any(|e| e.artwork_url.is_some()),
        "fetchedAt": rfc3339(src.fetched_at),
        "error": src.last_error,
        "episodes": episodes,
    });
    if admin {
        let o = v.as_object_mut().unwrap();
        o.insert("url".into(), json!(src.url));
        o.insert("nameCustom".into(), json!(src.name_custom));
        o.insert("position".into(), json!(src.position));
        o.insert("errorAt".into(), json!(rfc3339(src.error_at)));
        o.insert("createdAt".into(), json!(src.created_at));
    }
    v
}

#[derive(Deserialize, Default)]
struct RefreshQuery {
    refresh: Option<String>,
}

impl RefreshQuery {
    fn force(&self) -> bool {
        matches!(self.refresh.as_deref(), Some("1") | Some("true"))
    }
}

/// Every source with its latest episodes; stale ones are fetched now.
async fn list_sources(State(state): State<AppState>, Query(q): Query<RefreshQuery>) -> Response {
    if !enabled(&state) {
        return error_response(&PodcastError::Disabled);
    }
    let sources = match store::list(&state.db) {
        Ok(s) => s,
        Err(e) => return error_response(&e),
    };
    let force = q.force();
    // Spawned so a fetch that outlives LIST_WAIT still lands in the cache.
    let tasks: Vec<_> = sources
        .iter()
        .map(|s| {
            let state = state.clone();
            let id = s.id;
            tokio::spawn(async move { refresh_source(&state, id, force).await })
        })
        .collect();
    let _ = tokio::time::timeout(LIST_WAIT, futures::future::join_all(tasks)).await;
    let sources = match store::list(&state.db) {
        Ok(s) => s,
        Err(e) => return error_response(&e),
    };
    let ttl = state.config.lock_or_recover().podcasts.cache_ttl_minutes;
    ok(json!({
        "sources": sources.iter().map(|s| source_view(s, false)).collect::<Vec<_>>(),
        "cacheTtlMinutes": ttl,
    }))
}

async fn get_source(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<RefreshQuery>,
) -> Response {
    if !enabled(&state) {
        return error_response(&PodcastError::Disabled);
    }
    match refresh_source(&state, id, q.force()).await {
        Ok(src) => ok(source_view(&src, false)),
        Err(e) => error_response(&e),
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 32 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

async fn play(
    State(state): State<AppState>,
    Path((id, key)): Path<(i64, String)>,
    headers: HeaderMap,
) -> Response {
    if !enabled(&state) {
        return error_response(&PodcastError::Disabled);
    }
    if !valid_key(&key) {
        return error_response(&PodcastError::EpisodeNotFound);
    }
    proxy::stream(&state, id, &key, &headers).await
}

async fn art(State(state): State<AppState>, Path((id, key)): Path<(i64, String)>) -> Response {
    if !enabled(&state) {
        return error_response(&PodcastError::Disabled);
    }
    if !valid_key(&key) {
        return error_response(&PodcastError::EpisodeNotFound);
    }
    proxy::artwork(&state, id, &key).await
}

// ---- Admin ------------------------------------------------------------------

macro_rules! machine_op {
    ($state:expr, $headers:expr, $peer:expr) => {
        match crate::perm::require_machine_op($state, $headers, None, $peer) {
            Ok(op) => op,
            Err(r) => return r,
        }
    };
}

/// A source address without its query string and fragment (private feeds
/// carry tokens there), for callers that may not manage the hub.
fn redact_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            let had_secret =
                u.query().is_some() || u.fragment().is_some() || !u.username().is_empty();
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_username("");
            let _ = u.set_password(None);
            let mut s = u.to_string();
            if had_secret {
                s.push_str("?…");
            }
            s
        }
        Err(_) => raw.split(['?', '#']).next().unwrap_or("").to_string(),
    }
}

fn admin_payload(state: &AppState) -> Result<Value, PodcastError> {
    let settings = state.config.lock_or_recover().podcasts;
    let sources = store::list(&state.db)?;
    Ok(json!({
        "enabled": settings.enabled,
        "cacheTtlMinutes": settings.cache_ttl_minutes,
        "limits": {
            "maxSources": MAX_SOURCES,
            "maxEpisodes": MAX_EPISODE_COUNT,
            "defaultEpisodes": DEFAULT_EPISODE_COUNT,
            "minTtlMinutes": PodcastSettings::MIN_TTL_MINUTES,
            "maxTtlMinutes": PodcastSettings::MAX_TTL_MINUTES,
        },
        "ytdlpEnabled": crate::ytdlp::ytdlp_enabled(),
        "sources": sources.iter().map(|s| source_view(s, true)).collect::<Vec<_>>(),
    }))
}

/// Module settings and sources as stored (no fetch). Who may not manage the
/// hub sees the source addresses without their query strings.
async fn admin_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let reveal = crate::perm::require_machine_op(&state, &headers, None, peer).is_ok();
    match admin_payload(&state) {
        Ok(mut v) => {
            if !reveal {
                if let Some(list) = v.get_mut("sources").and_then(Value::as_array_mut) {
                    for s in list {
                        if let Some(u) = s.get("url").and_then(Value::as_str).map(redact_url) {
                            s["url"] = Value::String(u);
                        }
                    }
                }
            }
            ok(v)
        }
        Err(e) => error_response(&e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBody {
    enabled: Option<bool>,
    cache_ttl_minutes: Option<u32>,
}

async fn admin_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<SettingsBody>,
) -> Response {
    let op = machine_op!(&state, &headers, peer);
    let (data_dir, before, saved) = {
        let mut cfg = state.config.lock_or_recover();
        let before = cfg.podcasts;
        let mut next = before;
        if let Some(e) = body.enabled {
            next.enabled = e;
        }
        if let Some(t) = body.cache_ttl_minutes {
            next.cache_ttl_minutes = t;
        }
        let saved = cfg.save_podcast_settings(next);
        (cfg.data_dir.clone(), before, saved)
    };
    if let Err(e) = saved {
        return error_response(&PodcastError::Db(e.to_string()));
    }
    if let Some(on) = body.enabled.filter(|on| *on != before.enabled) {
        let event = if on {
            crate::diagnostics::ActivityEvent::new(
                "podcasts",
                "enabled",
                "modulo Podcast e notizie attivato",
            )
        } else {
            crate::diagnostics::ActivityEvent::new(
                "podcasts",
                "disabled",
                "modulo Podcast e notizie disattivato",
            )
        };
        crate::diagnostics::log_activity(&data_dir, event.account(Some(&op.account_id)));
    }
    match admin_payload(&state) {
        Ok(v) => ok(v),
        Err(e) => error_response(&e),
    }
}

fn episode_count_of(raw: Option<u32>) -> Result<u32, PodcastError> {
    let n = raw.unwrap_or(DEFAULT_EPISODE_COUNT);
    if !(1..=MAX_EPISODE_COUNT).contains(&n) {
        return Err(PodcastError::Invalid("invalid_episode_count"));
    }
    Ok(n)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestBody {
    url: String,
    episode_count: Option<u32>,
}

fn detected_view(d: &Detected, limit: u32) -> Value {
    json!({
        "kind": d.kind.as_str(),
        "live": d.kind == SourceKind::Live,
        "title": d.title,
        "hasArt": d.artwork_url.is_some(),
        "episodes": d.episodes.iter().take(limit as usize).map(|e| json!({
            "key": e.key,
            "title": e.title,
            "publishedAt": e.published_at,
            "durationSecs": e.duration_secs,
        })).collect::<Vec<_>>(),
    })
}

/// Preview: what the URL is and its latest episodes, nothing saved.
async fn admin_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<TestBody>,
) -> Response {
    let _op = machine_op!(&state, &headers, peer);
    let limit = match episode_count_of(body.episode_count) {
        Ok(n) => n,
        Err(e) => return error_response(&e),
    };
    let cfg = state.config.lock_or_recover().clone();
    match detect(&cfg, &state.podcasts.policy(), &body.url, limit).await {
        Ok(d) => ok(detected_view(&d, limit)),
        Err(e) => error_response(&e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBody {
    url: String,
    name: Option<String>,
    episode_count: Option<u32>,
}

fn clean_name(raw: Option<&str>) -> Option<String> {
    raw.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect())
}

fn unix_now() -> i64 {
    super::unix_now()
}

async fn admin_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<AddBody>,
) -> Response {
    let op = machine_op!(&state, &headers, peer);
    let limit = match episode_count_of(body.episode_count) {
        Ok(n) => n,
        Err(e) => return error_response(&e),
    };
    match store::count(&state.db) {
        Ok(n) if n >= MAX_SOURCES => return error_response(&PodcastError::Limit),
        Err(e) => return error_response(&e),
        _ => {}
    }
    let cfg = state.config.lock_or_recover().clone();
    let d = match detect(&cfg, &state.podcasts.policy(), &body.url, limit).await {
        Ok(d) => d,
        Err(e) => return error_response(&e),
    };
    let custom = clean_name(body.name.as_deref());
    let name = custom
        .clone()
        .or_else(|| clean_name(d.title.as_deref()))
        .or_else(|| {
            url::Url::parse(body.url.trim())
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| "Podcast".into());
    let now = unix_now();
    let id = match store::insert(
        &state.db,
        &NewSource {
            url: body.url.trim(),
            name: &name,
            name_custom: custom.is_some(),
            kind: d.kind,
            feed_url: &d.feed_url,
            episode_count: limit,
            artwork_url: d.artwork_url.as_deref(),
            episodes: &d.episodes,
            validators: &d.validators,
            fetched_at: (d.kind != SourceKind::Live).then_some(now),
        },
    ) {
        Ok(id) => id,
        Err(e) => return error_response(&e),
    };
    crate::diagnostics::log_activity(
        &cfg.data_dir,
        crate::diagnostics::ActivityEvent::new(
            "podcasts",
            "sourceAdded",
            format!("fonte podcast aggiunta: {name}"),
        )
        .params(json!({ "name": name, "kind": d.kind.as_str() }))
        .account(Some(&op.account_id)),
    );
    match store::get(&state.db, id) {
        Ok(Some(src)) => ok(source_view(&src, true)),
        Ok(None) => error_response(&PodcastError::SourceNotFound),
        Err(e) => error_response(&e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    /// New display name; empty → back to the feed's title.
    name: Option<String>,
    episode_count: Option<u32>,
    url: Option<String>,
}

async fn admin_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<i64>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let _op = machine_op!(&state, &headers, peer);
    // A refresh of this source in flight would save the old target's
    // episodes over the new one: wait for it, and keep new ones out.
    let lock = state.podcasts.source_lock(id);
    let _guard = lock.lock().await;
    let src = match store::get(&state.db, id) {
        Ok(Some(s)) => s,
        Ok(None) => return error_response(&PodcastError::SourceNotFound),
        Err(e) => return error_response(&e),
    };
    let count = match body
        .episode_count
        .map(|n| episode_count_of(Some(n)))
        .transpose()
    {
        Ok(c) => c,
        Err(e) => return error_response(&e),
    };
    if let Some(new_url) = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty() && *u != src.url)
    {
        let cfg = state.config.lock_or_recover().clone();
        let limit = count.unwrap_or(src.episode_count);
        let d = match detect(&cfg, &state.podcasts.policy(), new_url, limit).await {
            Ok(d) => d,
            Err(e) => return error_response(&e),
        };
        let now = unix_now();
        if let Err(e) = store::replace_target(
            &state.db,
            id,
            &NewSource {
                url: new_url,
                name: "",
                name_custom: false,
                kind: d.kind,
                feed_url: &d.feed_url,
                episode_count: limit,
                artwork_url: d.artwork_url.as_deref(),
                episodes: &d.episodes,
                validators: &d.validators,
                fetched_at: (d.kind != SourceKind::Live).then_some(now),
            },
        ) {
            return error_response(&e);
        }
        state.podcasts.forget_source(id);
        if !src.name_custom && body.name.is_none() {
            if let Some(t) = clean_name(d.title.as_deref()) {
                let _ = store::update_settings(&state.db, id, Some((&t, false)), None);
            }
        }
    }
    let name = body.name.as_deref().map(|raw| match clean_name(Some(raw)) {
        Some(n) => (n, true),
        // Empty: the feed's title takes over again at the next fetch.
        None => (src.name.clone(), false),
    });
    if let Err(e) = store::update_settings(
        &state.db,
        id,
        name.as_ref().map(|(n, c)| (n.as_str(), *c)),
        count,
    ) {
        return error_response(&e);
    }
    if name.as_ref().is_some_and(|(_, custom)| !custom) {
        // Name reset: the next fetch brings the feed's title back.
        if let Err(e) = store::invalidate(&state.db, id) {
            return error_response(&e);
        }
    }
    match store::get(&state.db, id) {
        Ok(Some(src)) => ok(source_view(&src, true)),
        Ok(None) => error_response(&PodcastError::SourceNotFound),
        Err(e) => error_response(&e),
    }
}

async fn admin_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Path(id): Path<i64>,
) -> Response {
    let op = machine_op!(&state, &headers, peer);
    let src = match store::get(&state.db, id) {
        Ok(Some(s)) => s,
        Ok(None) => return error_response(&PodcastError::SourceNotFound),
        Err(e) => return error_response(&e),
    };
    if let Err(e) = store::delete(&state.db, id) {
        return error_response(&e);
    }
    state.podcasts.forget_source(id);
    let data_dir = state.config.lock_or_recover().data_dir.clone();
    crate::diagnostics::log_activity(
        &data_dir,
        crate::diagnostics::ActivityEvent::new(
            "podcasts",
            "sourceRemoved",
            format!("fonte podcast rimossa: {}", src.name),
        )
        .params(json!({ "name": src.name }))
        .account(Some(&op.account_id)),
    );
    ok(json!({ "deleted": id }))
}

#[derive(Deserialize)]
struct OrderBody {
    ids: Vec<i64>,
}

async fn admin_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<OrderBody>,
) -> Response {
    let _op = machine_op!(&state, &headers, peer);
    if body.ids.len() > MAX_SOURCES * 2 {
        return error_response(&PodcastError::Invalid("invalid_order"));
    }
    if let Err(e) = store::reorder(&state.db, &body.ids) {
        return error_response(&e);
    }
    match admin_payload(&state) {
        Ok(v) => ok(v),
        Err(e) => error_response(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    #[test]
    fn redacted_urls_keep_no_tokens() {
        assert_eq!(
            redact_url("https://feeds.example.com/show/rss?auth=SECRET"),
            "https://feeds.example.com/show/rss?…"
        );
        assert_eq!(
            redact_url("https://user:pw@example.com/f.xml#t"),
            "https://example.com/f.xml?…"
        );
        assert_eq!(
            redact_url("https://example.com/f.xml"),
            "https://example.com/f.xml"
        );
        assert_eq!(redact_url("not a url?x=1"), "not a url");
    }
}
