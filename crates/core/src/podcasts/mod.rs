//! "Podcast e notizie": optional module, off by default.
//!
//! Sources (RSS / Atom feeds, web pages with a discoverable feed, play.rtl.it
//! archives, pages yt-dlp understands, live radio streams) are configured in
//! the admin panel. The hub fetches a source **only when a client asks** for
//! it and keeps the metadata of its latest episodes in SQLite for a TTL;
//! there is no background polling, no timer, no task while nobody looks.
//! Audio is never stored: clients play it through a hub proxy restricted to
//! the configured sources' episodes (see [`proxy`]).
//!
//! While the module is disabled every client endpoint answers 404
//! `podcasts_disabled` and nothing here runs.

pub mod api;
pub mod detect;
pub mod discover;
pub mod feed;
pub mod net;
pub mod proxy;
pub mod rtl;
pub mod store;
pub mod xml;
pub mod ytdlp_src;

use crate::sync::LockRecover;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use store::{Source, SourceKind};

/// Episodes per source: default and accepted range.
pub const DEFAULT_EPISODE_COUNT: u32 = 3;
pub const MAX_EPISODE_COUNT: u32 = 20;
/// Sources a hub keeps at most.
pub const MAX_SOURCES: usize = 50;
/// Metadata fetches running at once (all sources share them).
const FETCH_SLOTS: usize = 4;

/// One episode's metadata. Upstream URLs stay on the hub: clients get
/// [`EpisodeView`] and play through the proxy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    /// Stable id inside its source (hash of the guid).
    pub key: String,
    pub title: String,
    /// RFC 3339, UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u32>,
    /// Audio URL, when known without a resolver (feeds, RTL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_url: Option<String>,
    /// Entry page (yt-dlp resolves the audio from it on play).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

/// Stable short id of an episode from its guid (or URL).
pub fn episode_key(guid: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(guid.trim().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Key of the single item of a live source.
pub const LIVE_KEY: &str = "live";

#[derive(Debug, thiserror::Error)]
pub enum PodcastError {
    #[error("the podcasts module is disabled")]
    Disabled,
    #[error("invalid URL")]
    InvalidUrl,
    #[error("URL not allowed (private or local address)")]
    UrlNotAllowed,
    #[error("request timed out")]
    Timeout,
    /// Network failure (connect, TLS, DNS, body cut short): worth a retry.
    #[error("{0}")]
    Fetch(String),
    /// A redirect that cannot be followed: retrying would not help.
    #[error("{0}")]
    Redirect(&'static str),
    #[error("upstream HTTP {0}")]
    Http(u16),
    #[error("response too large")]
    TooLarge,
    #[error("{0}")]
    Parse(String),
    #[error("no feed, playlist or stream found at this address")]
    Unsupported,
    #[error("HLS (.m3u8) streams are not supported")]
    Hls,
    #[error("no playable episodes found")]
    NoEpisodes,
    #[error("source not found")]
    SourceNotFound,
    #[error("episode not found")]
    EpisodeNotFound,
    #[error("yt-dlp is disabled on this hub")]
    YtdlpDisabled,
    #[error("yt-dlp not found")]
    YtdlpNotFound,
    #[error("{1}")]
    Ytdlp(&'static str, String),
    #[error("could not resolve the audio stream")]
    Resolve,
    #[error("too many streams at once")]
    Busy,
    #[error("too many sources")]
    Limit,
    #[error("invalid request: {0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Db(String),
}

impl PodcastError {
    /// Stable code the clients translate.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "podcasts_disabled",
            Self::InvalidUrl => "podcast_invalid_url",
            Self::UrlNotAllowed => "url_not_allowed",
            Self::Timeout => "podcast_fetch_timeout",
            Self::Fetch(_) | Self::Redirect(_) => "podcast_fetch_failed",
            Self::Http(_) => "podcast_http_error",
            Self::TooLarge => "podcast_too_large",
            Self::Parse(_) => "podcast_parse_failed",
            Self::Unsupported => "podcast_unsupported_url",
            Self::Hls => "podcast_hls_unsupported",
            Self::NoEpisodes => "podcast_no_episodes",
            Self::SourceNotFound => "podcast_source_not_found",
            Self::EpisodeNotFound => "podcast_episode_not_found",
            Self::YtdlpDisabled => "ytdlp_disabled",
            Self::YtdlpNotFound => "ytdlp_not_found",
            Self::Ytdlp(code, _) => code,
            Self::Resolve => "podcast_resolve_failed",
            Self::Busy => "podcast_proxy_busy",
            Self::Limit => "podcast_limit_reached",
            Self::Invalid(code) => code,
            Self::Db(_) => "db_error",
        }
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode as S;
        match self {
            Self::Disabled | Self::SourceNotFound | Self::EpisodeNotFound => S::NOT_FOUND,
            Self::InvalidUrl | Self::UrlNotAllowed | Self::Invalid(_) => S::BAD_REQUEST,
            Self::Unsupported | Self::Hls | Self::NoEpisodes => S::UNPROCESSABLE_ENTITY,
            Self::Timeout => S::GATEWAY_TIMEOUT,
            Self::YtdlpDisabled => S::FORBIDDEN,
            Self::YtdlpNotFound | Self::Busy => S::SERVICE_UNAVAILABLE,
            Self::Limit => S::CONFLICT,
            Self::Db(_) => S::INTERNAL_SERVER_ERROR,
            _ => S::BAD_GATEWAY,
        }
    }
}

/// In-memory state of the module. Created with the hub but idle: no task,
/// no timer; entries expire when they are next looked at.
pub struct Runtime {
    policy: Mutex<net::NetPolicy>,
    fetch_slots: tokio::sync::Semaphore,
    source_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// Audio URLs yt-dlp resolved (signed, short lived).
    resolved: Mutex<HashMap<(i64, String), (String, Instant)>>,
    /// Upstream URLs of episodes being played: a list refresh that drops
    /// an episode must not cut it off mid-listen.
    playing: Mutex<HashMap<(i64, String), PlayingEntry>>,
    /// Proxied streams open right now.
    pub(crate) streams: AtomicUsize,
}

/// `(upstream URL, live, noted at)` of an episode being played.
type PlayingEntry = (String, bool, Instant);

/// How long a yt-dlp audio URL is reused.
const RESOLVED_TTL: Duration = Duration::from_secs(20 * 60);
/// How long a played episode stays proxyable after it left the list.
const PLAYING_GRACE: Duration = Duration::from_secs(6 * 3600);
const PLAYING_MAX: usize = 64;

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self {
            policy: Mutex::new(net::NetPolicy::default()),
            fetch_slots: tokio::sync::Semaphore::new(FETCH_SLOTS),
            source_locks: Mutex::new(HashMap::new()),
            resolved: Mutex::new(HashMap::new()),
            playing: Mutex::new(HashMap::new()),
            streams: AtomicUsize::new(0),
        }
    }

    pub fn policy(&self) -> net::NetPolicy {
        self.policy.lock_or_recover().clone()
    }

    /// Tests only: let the module reach local fixture servers.
    #[doc(hidden)]
    pub fn set_policy_for_tests(&self, policy: net::NetPolicy) {
        *self.policy.lock_or_recover() = policy;
    }

    fn source_lock(&self, id: i64) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.source_locks.lock_or_recover();
        map.retain(|_, l| Arc::strong_count(l) > 1);
        map.entry(id).or_default().clone()
    }

    pub(crate) fn cached_resolution(&self, id: i64, key: &str) -> Option<String> {
        let mut map = self.resolved.lock_or_recover();
        let now = Instant::now();
        map.retain(|_, (_, at)| now.duration_since(*at) < RESOLVED_TTL);
        map.get(&(id, key.to_string())).map(|(u, _)| u.clone())
    }

    pub(crate) fn remember_resolution(&self, id: i64, key: &str, url: &str) {
        self.resolved
            .lock_or_recover()
            .insert((id, key.to_string()), (url.to_string(), Instant::now()));
    }

    pub(crate) fn forget_resolution(&self, id: i64, key: &str) {
        self.resolved
            .lock_or_recover()
            .remove(&(id, key.to_string()));
        self.playing
            .lock_or_recover()
            .remove(&(id, key.to_string()));
    }

    pub(crate) fn playing_url(&self, id: i64, key: &str) -> Option<(String, bool)> {
        let mut map = self.playing.lock_or_recover();
        let now = Instant::now();
        map.retain(|_, (_, _, at)| now.duration_since(*at) < PLAYING_GRACE);
        map.get(&(id, key.to_string()))
            .map(|(u, live, _)| (u.clone(), *live))
    }

    pub(crate) fn note_playing(&self, id: i64, key: &str, url: &str, live: bool) {
        let mut map = self.playing.lock_or_recover();
        if map.len() >= PLAYING_MAX {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, (_, _, at))| *at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        map.insert(
            (id, key.to_string()),
            (url.to_string(), live, Instant::now()),
        );
    }

    /// Drop everything cached for a source (edited or deleted).
    pub(crate) fn forget_source(&self, id: i64) {
        self.resolved
            .lock_or_recover()
            .retain(|(sid, _), _| *sid != id);
        self.playing
            .lock_or_recover()
            .retain(|(sid, _), _| *sid != id);
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A manual refresh within this many seconds of the last fetch reuses it.
const MANUAL_REFRESH_MIN_SECS: i64 = 30;
/// After a failed fetch, automatic refreshes wait this long.
const ERROR_BACKOFF_SECS: i64 = 60;

/// Whether `src` must be fetched now (TTL elapsed, or forced).
pub fn needs_fetch(src: &Source, ttl_secs: i64, now: i64, force: bool) -> bool {
    if src.kind == SourceKind::Live {
        return false;
    }
    let age = src.fetched_at.map(|t| now - t);
    if force {
        // A failed attempt counts too: a client asking again and again must
        // not make the hub refetch a broken source nonstop.
        let last = src.fetched_at.max(src.error_at);
        return last.is_none_or(|t| now - t >= MANUAL_REFRESH_MIN_SECS);
    }
    if src
        .error_at
        .is_some_and(|t| now - t < ERROR_BACKOFF_SECS && src.fetched_at.is_none_or(|f| t >= f))
    {
        return false;
    }
    age.is_none_or(|a| a >= ttl_secs)
}

/// Fetch a source if it is stale (or `force`), on demand only. Concurrent
/// callers for one source share the fetch; at most `FETCH_SLOTS` run at once.
pub async fn refresh_source(
    state: &crate::AppState,
    id: i64,
    force: bool,
) -> Result<Source, PodcastError> {
    let rt = state.podcasts.clone();
    let lock = rt.source_lock(id);
    let _guard = lock.lock().await;
    let src = store::get(&state.db, id)?.ok_or(PodcastError::SourceNotFound)?;
    let (cfg, ttl) = {
        let cfg = state.config.lock_or_recover().clone();
        let ttl = i64::from(cfg.podcasts.cache_ttl_minutes) * 60;
        (cfg, ttl)
    };
    let now = unix_now();
    if !needs_fetch(&src, ttl, now, force) {
        return Ok(src);
    }
    let _permit = rt
        .fetch_slots
        .acquire()
        .await
        .map_err(|_| PodcastError::Busy)?;
    let policy = rt.policy();
    let outcome = detect::fetch_episodes(&cfg, &policy, &src).await;
    match outcome {
        Ok(detect::Refreshed::NotModified) => store::touch(&state.db, id, now)?,
        Ok(detect::Refreshed::Fresh {
            title,
            artwork_url,
            episodes,
            validators,
            retarget,
        }) => {
            if let Some(feed_url) = retarget {
                store::retarget(&state.db, id, SourceKind::Rss, &feed_url)?;
                rt.forget_source(id);
            }
            store::save_fetch(
                &state.db,
                id,
                &store::FetchSave {
                    title: title.as_deref(),
                    artwork_url: artwork_url.as_deref(),
                    episodes: &episodes,
                    validators: &validators,
                    at: now,
                },
            )?
        }
        Err(e) => {
            tracing::warn!(source = id, code = e.code(), error = %e, "podcast source fetch failed");
            store::save_error(&state.db, id, e.code(), now)?;
        }
    }
    store::get(&state.db, id)?.ok_or(PodcastError::SourceNotFound)
}

/// Whether the module is on (hub setting).
pub fn enabled(state: &crate::AppState) -> bool {
    state.config.lock_or_recover().podcasts.enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(kind: SourceKind, fetched_at: Option<i64>, error_at: Option<i64>) -> Source {
        Source {
            id: 1,
            url: String::new(),
            name: String::new(),
            name_custom: false,
            kind,
            feed_url: String::new(),
            episode_count: 3,
            position: 0,
            artwork_url: None,
            created_at: String::new(),
            fetched_at,
            etag: None,
            last_modified: None,
            last_error: error_at.map(|_| "podcast_fetch_failed".into()),
            error_at,
            episodes: Vec::new(),
        }
    }

    #[test]
    fn ttl_and_backoff_decide_fetches() {
        let now = 1_000_000;
        let ttl = 30 * 60;
        // Never fetched → fetch; fresh → no; stale → yes.
        assert!(needs_fetch(
            &src(SourceKind::Rss, None, None),
            ttl,
            now,
            false
        ));
        assert!(!needs_fetch(
            &src(SourceKind::Rss, Some(now - 60), None),
            ttl,
            now,
            false
        ));
        assert!(needs_fetch(
            &src(SourceKind::Rss, Some(now - ttl), None),
            ttl,
            now,
            false
        ));
        // A forced refresh honours a recent failure too (no refetch loop).
        assert!(!needs_fetch(
            &src(SourceKind::Rss, None, Some(now - 5)),
            ttl,
            now,
            true
        ));
        assert!(!needs_fetch(
            &src(SourceKind::Rss, Some(now - ttl * 2), Some(now - 5)),
            ttl,
            now,
            true
        ));
        assert!(needs_fetch(
            &src(SourceKind::Rss, Some(now - ttl * 2), Some(now - 40)),
            ttl,
            now,
            true
        ));
        // A recent failure holds automatic retries back for a minute.
        assert!(!needs_fetch(
            &src(SourceKind::Rss, Some(now - ttl * 2), Some(now - 10)),
            ttl,
            now,
            false
        ));
        assert!(needs_fetch(
            &src(SourceKind::Rss, Some(now - ttl * 2), Some(now - 120)),
            ttl,
            now,
            false
        ));
        // Manual refresh: allowed unless the last fetch is seconds old.
        assert!(!needs_fetch(
            &src(SourceKind::Rss, Some(now - 5), None),
            ttl,
            now,
            true
        ));
        assert!(needs_fetch(
            &src(SourceKind::Rss, Some(now - 60), None),
            ttl,
            now,
            true
        ));
        // Live streams have nothing to fetch.
        assert!(!needs_fetch(
            &src(SourceKind::Live, None, None),
            ttl,
            now,
            true
        ));
    }

    #[test]
    fn grace_and_resolution_caches() {
        let rt = Runtime::new();
        rt.remember_resolution(1, "k", "https://cdn.example/a");
        assert_eq!(
            rt.cached_resolution(1, "k").as_deref(),
            Some("https://cdn.example/a")
        );
        rt.note_playing(1, "k", "https://cdn.example/a", false);
        assert!(rt.playing_url(1, "k").is_some());
        rt.forget_source(1);
        assert!(rt.cached_resolution(1, "k").is_none());
        assert!(rt.playing_url(1, "k").is_none());
        for i in 0..(PLAYING_MAX + 5) {
            rt.note_playing(2, &format!("e{i}"), "https://x", false);
        }
        assert!(rt.playing.lock_or_recover().len() <= PLAYING_MAX);
    }
}
