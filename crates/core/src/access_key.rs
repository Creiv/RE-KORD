//! Optional hub access key (`REKORD_ACCESS_KEY`).
//!
//! Unset: nothing changes. Set: every request to `/api` and `/media` must
//! present the key, either in the `X-Rekord-Access-Key` header (API calls) or
//! in the `accessKey` query parameter (`<audio>`, `<img>`, downloads, Cast:
//! things that cannot send headers). The header wins when both are present.
//!
//! - The health endpoint stays reachable without the key, with a minimal body
//!   (`accessKey: "required"`), so clients can tell a hub that wants a key from
//!   one that is down. A wrong key on health is refused like anywhere else:
//!   that is how clients validate a key.
//! - Local requests are not exempt: a reverse proxy on the hub machine that
//!   rewrites `Host` and adds no forwarding headers makes every remote request
//!   look local (see `perm::is_local_request`). The key is a layer in front of
//!   the local / remote rules, it does not replace them.
//! - Only the SHA-256 of the key is kept, compared in constant time. The key is
//!   never logged nor echoed, and the query parameter is removed from the URI
//!   before the request reaches the handlers.
//! - Repeated wrong keys from one source get 429 for a short while (see
//!   [`Limiter`]); the right key always gets in.
//!
//! A key in a URL can end up in reverse-proxy access logs, browser history or
//! on a Cast device; `Referrer-Policy: no-referrer` (see `origin.rs`) keeps it
//! out of `Referer`. The header is used wherever the client can send one.

use crate::state::AppState;
use anyhow::{bail, Result};
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

pub const ACCESS_KEY_ENV: &str = "REKORD_ACCESS_KEY";
pub const ACCESS_KEY_HEADER: &str = "x-rekord-access-key";
pub const ACCESS_KEY_QUERY: &str = "accessKey";

pub const MIN_KEY_LEN: usize = 32;
pub const MAX_KEY_LEN: usize = 256;
/// Different characters a key needs: "aaaa…" or "0101…" are long but guessable.
pub const MIN_DISTINCT_CHARS: usize = 10;
/// How every key refusal ends: what to use instead.
const KEY_ADVICE: &str = "generate one with `openssl rand -hex 32`";
/// Longer presented values are refused without hashing.
const MAX_PRESENTED_LEN: usize = 1024;

/// 401: no key presented.
pub const ACCESS_KEY_REQUIRED: &str = "access_key_required";
/// 401: a key was presented and it is wrong.
pub const ACCESS_KEY_INVALID: &str = "access_key_invalid";
/// 429: too many wrong keys from this source.
pub const ACCESS_KEY_RATE_LIMITED: &str = "access_key_rate_limited";

/// Distinct wrong keys from one source within [`FAILURE_WINDOW`] that trigger a lock.
const MAX_DISTINCT_FAILURES: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// Short on purpose: a lock also hits a legitimate client sharing the source.
const LOCK_DURATION: Duration = Duration::from_secs(60);
/// Tracked sources; the least recently seen one is dropped beyond this.
const MAX_SOURCES: usize = 4096;

fn key_allowed_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-')
}

/// Why a configured key is refused. Messages never include the value.
fn validate_key(raw: &str) -> Result<()> {
    if raw.is_empty() {
        bail!("{ACCESS_KEY_ENV} is set but empty: unset it or give it a key");
    }
    if !raw.chars().all(key_allowed_char) {
        bail!(
            "{ACCESS_KEY_ENV} may only contain A-Z, a-z, 0-9, '.', '_', '~' and '-' \
             (no spaces or line breaks)"
        );
    }
    if raw.len() < MIN_KEY_LEN {
        bail!("{ACCESS_KEY_ENV} must be at least {MIN_KEY_LEN} characters long: {KEY_ADVICE}");
    }
    if raw.len() > MAX_KEY_LEN {
        bail!("{ACCESS_KEY_ENV} must be at most {MAX_KEY_LEN} characters long");
    }
    if distinct_chars(raw) < MIN_DISTINCT_CHARS {
        bail!(
            "{ACCESS_KEY_ENV} is too weak: it needs at least {MIN_DISTINCT_CHARS} different \
             characters; {KEY_ADVICE}"
        );
    }
    if is_repeated_block(raw) {
        bail!("{ACCESS_KEY_ENV} is too weak: it repeats a shorter block; {KEY_ADVICE}");
    }
    Ok(())
}

fn distinct_chars(raw: &str) -> usize {
    let mut seen = [false; 128];
    raw.bytes()
        .filter(|&b| !std::mem::replace(&mut seen[usize::from(b & 0x7f)], true))
        .count()
}

/// True when `raw` is a shorter block written two or more times ("abab…",
/// "0123456789abcdef0123456789abcdef"); a last, partial copy counts too.
fn is_repeated_block(raw: &str) -> bool {
    let b = raw.as_bytes();
    (1..=b.len() / 2).any(|period| (period..b.len()).all(|i| b[i] == b[i - period]))
}

/// The configured key (as a digest) and the wrong-key limiter.
pub struct AccessGate {
    digest: [u8; 32],
    limiter: Limiter,
}

impl std::fmt::Debug for AccessGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccessGate(<redacted>)")
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

impl AccessGate {
    pub fn new(raw: &str) -> Result<Self> {
        validate_key(raw)?;
        Ok(Self {
            digest: sha256(raw.as_bytes()),
            limiter: Limiter::default(),
        })
    }

    /// Constant time over the digests, so neither content nor length leaks.
    pub fn matches(&self, presented: &str) -> bool {
        if presented.len() > MAX_PRESENTED_LEN {
            return false;
        }
        sha256(presented.as_bytes()).ct_eq(&self.digest).into()
    }
}

/// `None` when the variable is unset; an error (the hub must not start) when
/// it is set but empty or invalid.
pub fn gate_from_env() -> Result<Option<AccessGate>> {
    gate_from_value(std::env::var_os(ACCESS_KEY_ENV))
}

fn gate_from_value(value: Option<std::ffi::OsString>) -> Result<Option<AccessGate>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let Some(raw) = raw.to_str() else {
        bail!("{ACCESS_KEY_ENV} is not valid UTF-8");
    };
    AccessGate::new(raw).map(Some)
}

/// Access outcome left in the request extensions for the health handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The request presented the right key.
    Granted,
    /// No key presented (only health gets this far).
    Missing,
}

/// What health may show: `"off"`, `"ok"` or `"required"` (minimal body).
pub fn health_access(state: &AppState, access: Option<Access>) -> &'static str {
    match (&state.access_key, access) {
        (None, _) => "off",
        (Some(_), Some(Access::Granted)) => "ok",
        (Some(_), _) => "required",
    }
}

fn is_protected(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/") || path == "/media" || path.starts_with("/media/")
}

fn is_health(path: &str) -> bool {
    matches!(path, "/api/v1/health" | "/api/health")
}

fn query_param_name(segment: &str) -> String {
    let name = segment.split('=').next().unwrap_or("");
    url::form_urlencoded::parse(name.as_bytes())
        .next()
        .map(|(k, _)| k.into_owned())
        .unwrap_or_default()
}

/// The first non-empty `accessKey` of the query.
fn query_key(query: Option<&str>) -> Option<String> {
    url::form_urlencoded::parse(query?.as_bytes())
        .find(|(k, v)| k == ACCESS_KEY_QUERY && !v.is_empty())
        .map(|(_, v)| v.into_owned())
}

/// Header first, then query. Empty values count as absent.
fn presented_key(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    let from_header = headers
        .get(ACCESS_KEY_HEADER)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).trim().to_string())
        .filter(|s| !s.is_empty());
    from_header.or_else(|| query_key(uri.query()))
}

/// `uri` without any `accessKey` parameter; other parameters stay byte for byte.
fn strip_key_from_uri(uri: &Uri) -> Option<Uri> {
    let query = uri.query()?;
    if !query
        .split('&')
        .any(|s| query_param_name(s) == ACCESS_KEY_QUERY)
    {
        return None;
    }
    let kept: Vec<&str> = query
        .split('&')
        .filter(|s| !s.is_empty() && query_param_name(s) != ACCESS_KEY_QUERY)
        .collect();
    let path_and_query = if kept.is_empty() {
        uri.path().to_string()
    } else {
        format!("{}?{}", uri.path(), kept.join("&"))
    };
    let mut parts = uri.clone().into_parts();
    parts.path_and_query = Some(path_and_query.parse().ok()?);
    Uri::from_parts(parts).ok()
}

/// IPv6 clients are grouped by /64: one host usually owns the whole prefix.
fn source_bucket(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) if !v6.is_loopback() => {
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

/// Who the limiter counts: the address of the connection, nothing else.
/// Forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP`) are ignored:
/// any client can write them, and a reverse proxy in front of the hub does not
/// always replace them. Behind a proxy (or Docker's bridge) every client shares
/// one source, which is why the lock never refuses the right key.
fn client_source(peer: Option<SocketAddr>) -> IpAddr {
    peer.map(|p| source_bucket(p.ip()))
        .unwrap_or(IpAddr::from([127, 0, 0, 1]))
}

#[derive(Debug)]
struct SourceState {
    window_start: Instant,
    /// Short fingerprints of the distinct wrong keys in the current window.
    wrong: Vec<u64>,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

/// Wrong-key limiter, in memory, per source.
///
/// Only *distinct* wrong keys count, so a client still holding an old key
/// (and asking for fifty covers with it) does not lock itself out. A locked
/// source gets 429 for every wrong key, but the right key is checked first and
/// always gets in: many clients can share one source (Docker's bridge, a NAT,
/// a reverse proxy) and a stranger must not be able to lock them all out. The
/// price is that the lock does not slow down guessing, since a right guess is
/// answered at once; that is left to the key itself (length and the weak-key
/// rule). Sources are never logged.
#[derive(Debug, Default)]
pub struct Limiter {
    sources: Mutex<HashMap<IpAddr, SourceState>>,
}

impl Limiter {
    /// Remaining lock time for `source`, if locked.
    pub fn locked_for(&self, source: IpAddr, now: Instant) -> Option<Duration> {
        let mut map = self.sources.lock().unwrap();
        let entry = map.get_mut(&source)?;
        match entry.locked_until {
            Some(until) if until > now => Some(until - now),
            Some(_) => {
                entry.locked_until = None;
                None
            }
            None => None,
        }
    }

    /// Record a wrong key; true when this failure locks the source.
    pub fn record_failure(&self, source: IpAddr, presented: &str, now: Instant) -> bool {
        let digest = sha256(presented.as_bytes());
        let fingerprint = u64::from_le_bytes(digest[..8].try_into().unwrap());
        let mut map = self.sources.lock().unwrap();
        if !map.contains_key(&source) && map.len() >= MAX_SOURCES {
            evict(&mut map, now);
        }
        let entry = map.entry(source).or_insert_with(|| SourceState {
            window_start: now,
            wrong: Vec::new(),
            locked_until: None,
            last_seen: now,
        });
        entry.last_seen = now;
        if now.duration_since(entry.window_start) > FAILURE_WINDOW {
            entry.window_start = now;
            entry.wrong.clear();
        }
        if !entry.wrong.contains(&fingerprint) {
            entry.wrong.push(fingerprint);
        }
        if entry.wrong.len() >= MAX_DISTINCT_FAILURES {
            entry.locked_until = Some(now + LOCK_DURATION);
            entry.wrong.clear();
            entry.window_start = now;
            return true;
        }
        false
    }
}

/// Make room: drop idle sources, else the least recently seen one.
fn evict(map: &mut HashMap<IpAddr, SourceState>, now: Instant) {
    map.retain(|_, s| {
        s.locked_until.is_some_and(|u| u > now)
            || now.duration_since(s.window_start) <= FAILURE_WINDOW
    });
    if map.len() >= MAX_SOURCES {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, s)| s.last_seen)
            .map(|(ip, _)| *ip)
        {
            map.remove(&oldest);
        }
    }
}

fn refusal(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    let mut res = (
        status,
        Json(json!({ "ok": false, "data": null, "error": code, "message": message })),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn rate_limited(retry_after: Duration) -> Response {
    let mut res = refusal(
        StatusCode::TOO_MANY_REQUESTS,
        ACCESS_KEY_RATE_LIMITED,
        "too many wrong access keys, try again later",
    );
    let secs = retry_after.as_secs().max(1);
    if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, v);
    }
    res
}

/// Require the key on `/api` and `/media` when one is configured.
///
/// Sits inside the CORS layer: preflights are answered there without a key,
/// and refusals still carry `Access-Control-Allow-Origin` for allowed origins.
pub async fn access_key_guard(
    State(state): State<AppState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let Some(gate) = state.access_key.clone() else {
        return next.run(req).await;
    };
    let path = req.uri().path();
    if !is_protected(path) {
        return next.run(req).await;
    }
    let health = is_health(path);
    let access = match presented_key(req.headers(), req.uri()) {
        None if health => Access::Missing,
        None => {
            return refusal(
                StatusCode::UNAUTHORIZED,
                ACCESS_KEY_REQUIRED,
                "this hub requires an access key",
            )
        }
        Some(key) => {
            let peer = req
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr);
            // The right key gets in even from a locked source: the lock only
            // answers wrong keys.
            if !gate.matches(&key) {
                let source = client_source(peer);
                let now = Instant::now();
                if let Some(left) = gate.limiter.locked_for(source, now) {
                    return rate_limited(left);
                }
                if gate.limiter.record_failure(source, &key, now) {
                    return rate_limited(LOCK_DURATION);
                }
                return refusal(
                    StatusCode::UNAUTHORIZED,
                    ACCESS_KEY_INVALID,
                    "wrong access key",
                );
            }
            Access::Granted
        }
    };
    // Handlers, redirects and anything downstream never see the key.
    req.headers_mut().remove(ACCESS_KEY_HEADER);
    if let Some(uri) = strip_key_from_uri(req.uri()) {
        *req.uri_mut() = uri;
    }
    req.extensions_mut().insert(access);
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdefABCDEF._~-xyzXYZ";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    fn addr(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn unset_variable_means_no_gate() {
        assert!(gate_from_value(None).unwrap().is_none());
    }

    #[test]
    fn empty_or_invalid_key_is_refused_without_echoing_it() {
        for bad in [
            "",
            "short",
            &"a".repeat(MIN_KEY_LEN - 1),
            &"a".repeat(MAX_KEY_LEN + 1),
            &format!("{} ", "a".repeat(MIN_KEY_LEN)),
            &format!("{}\n", "a".repeat(MIN_KEY_LEN)),
            &format!("{}/+=", "a".repeat(MIN_KEY_LEN)),
            &format!("{}é", "a".repeat(MIN_KEY_LEN)),
        ] {
            let err = gate_from_value(Some(bad.into())).unwrap_err().to_string();
            assert!(err.contains(ACCESS_KEY_ENV), "{err}");
            if !bad.is_empty() {
                assert!(!err.contains(bad.trim()), "error echoes the key: {err}");
            }
        }
        assert!(gate_from_value(Some(KEY.into())).unwrap().is_some());
        assert!(gate_from_value(Some(long_strong_key(MAX_KEY_LEN).into()))
            .unwrap()
            .is_some());
    }

    /// Non-repeating, varied key of `len` characters (hex of chained digests).
    fn long_strong_key(len: usize) -> String {
        let mut out = String::new();
        let mut seed = sha256(b"rekord");
        while out.len() < len {
            out.extend(seed.iter().map(|b| format!("{b:02x}")));
            seed = sha256(&seed);
        }
        out.truncate(len);
        out
    }

    #[test]
    fn weak_keys_are_refused_with_advice_and_without_echoing_them() {
        for weak in [
            "a".repeat(MIN_KEY_LEN),                          // one character
            "ab".repeat(MIN_KEY_LEN / 2),                     // short block
            "abcdefghij".repeat(4),                           // block of 10 (10 distinct)
            "0123456789abcdef".repeat(2),                     // 16-char block twice
            format!("{}012", "0123456789abcdef".repeat(2)),   // twice + partial copy
            "aabbaabbababbbaaabbbabababaaabbbaa".to_string(), // 2 distinct, no period
        ] {
            let err = gate_from_value(Some(weak.as_str().into()))
                .unwrap_err()
                .to_string();
            assert!(err.contains("too weak"), "{weak}: {err}");
            assert!(err.contains("openssl rand -hex 32"), "{err}");
            assert!(!err.contains(weak.as_str()), "error echoes the key: {err}");
        }
        // Length errors give the same advice.
        let err = gate_from_value(Some("short".into()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("openssl rand -hex 32"), "{err}");
    }

    #[test]
    fn random_hex_and_passphrases_pass() {
        // `openssl rand -hex 32` (a sample) and a long passphrase.
        for strong in [
            "cc9b2de94f2fcbce7d02414981b992a2ed015373de86c3c16d04710ee0ff7c04",
            "tren-lago-nube-sal-mesa-ruido-faro",
            KEY,
        ] {
            assert!(
                gate_from_value(Some(strong.into())).unwrap().is_some(),
                "{strong}"
            );
        }
        // A 29-character passphrase is refused by length (minimum 32), not as weak.
        let err = gate_from_value(Some("tren-lago-nube-sal-mesa-ruido".into()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("at least 32"), "{err}");
    }

    #[test]
    fn weak_key_rules() {
        assert_eq!(distinct_chars("aaaa"), 1);
        assert_eq!(distinct_chars("tren-lago-nube-sal-mesa-ruido-faro"), 16);
        assert!(is_repeated_block("abab"));
        assert!(is_repeated_block("abcabca"));
        assert!(!is_repeated_block("abcabd"));
        assert!(!is_repeated_block(KEY));
    }

    #[test]
    fn matches_only_the_exact_key() {
        let gate = AccessGate::new(KEY).unwrap();
        assert!(gate.matches(KEY));
        assert!(!gate.matches(&KEY[..KEY.len() - 1]));
        assert!(!gate.matches(&format!("{KEY}x")));
        assert!(!gate.matches(&KEY.to_uppercase()));
        assert!(!gate.matches(""));
        assert!(!gate.matches(&"a".repeat(MAX_PRESENTED_LEN + 1)));
    }

    #[test]
    fn debug_does_not_print_the_key() {
        let gate = AccessGate::new(KEY).unwrap();
        let shown = format!("{gate:?}");
        assert!(!shown.contains(KEY));
        assert!(!shown.contains("0123"));
    }

    #[test]
    fn header_wins_over_query() {
        let uri: Uri = "/media/a.mp3?accessKey=fromquery".parse().unwrap();
        let h = headers(&[(ACCESS_KEY_HEADER, "fromheader")]);
        assert_eq!(presented_key(&h, &uri).as_deref(), Some("fromheader"));
        assert_eq!(
            presented_key(&HeaderMap::new(), &uri).as_deref(),
            Some("fromquery")
        );
        let h = headers(&[(ACCESS_KEY_HEADER, "  ")]);
        assert_eq!(presented_key(&h, &uri).as_deref(), Some("fromquery"));
        let empty: Uri = "/media/a.mp3?accessKey=".parse().unwrap();
        assert_eq!(presented_key(&HeaderMap::new(), &empty), None);
    }

    #[test]
    fn strip_removes_every_key_and_keeps_the_rest_verbatim() {
        let uri: Uri = "/api/v1/transcode/a%20b.wma?format=flac&accessKey=k&x=%2F&accessKey=k2"
            .parse()
            .unwrap();
        let out = strip_key_from_uri(&uri).unwrap();
        assert_eq!(out.path(), "/api/v1/transcode/a%20b.wma");
        assert_eq!(out.query(), Some("format=flac&x=%2F"));
        let only: Uri = "/media/a.mp3?accessKey=k".parse().unwrap();
        assert_eq!(
            strip_key_from_uri(&only).unwrap().to_string(),
            "/media/a.mp3"
        );
        let none: Uri = "/media/a.mp3?v=2".parse().unwrap();
        assert!(strip_key_from_uri(&none).is_none());
        // Percent-encoded parameter name.
        let enc: Uri = "/media/a.mp3?access%4Bey=k".parse().unwrap();
        assert_eq!(
            strip_key_from_uri(&enc).unwrap().to_string(),
            "/media/a.mp3"
        );
    }

    #[test]
    fn the_source_is_the_peer_address() {
        let lan = client_source(addr("192.168.1.20:5000"));
        assert_eq!(lan, "192.168.1.20".parse::<IpAddr>().unwrap());
        let loopback = client_source(addr("127.0.0.1:5000"));
        assert_eq!(loopback, "127.0.0.1".parse::<IpAddr>().unwrap());
        assert!(client_source(addr("[::1]:5000")).is_loopback());
        // No connect info (tests, embedded routers): one loopback source.
        assert!(client_source(None).is_loopback());
    }

    #[test]
    fn ipv6_sources_are_grouped_by_prefix() {
        let a = client_source(addr("[2001:db8:1:2::1]:5000"));
        let b = client_source(addr("[2001:db8:1:2:ffff::9]:5000"));
        assert_eq!(a, b);
        let mapped = client_source(addr("[::ffff:192.168.1.20]:5000"));
        assert_eq!(mapped, "192.168.1.20".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn distinct_wrong_keys_lock_a_source_briefly() {
        let lim = Limiter::default();
        let src: IpAddr = "192.168.1.20".parse().unwrap();
        let other: IpAddr = "192.168.1.21".parse().unwrap();
        let t0 = Instant::now();
        for i in 0..MAX_DISTINCT_FAILURES - 1 {
            assert!(!lim.record_failure(src, &format!("guess{i}"), t0));
        }
        assert!(lim.locked_for(src, t0).is_none());
        assert!(lim.record_failure(src, "guess-last", t0));
        assert!(lim.locked_for(src, t0).is_some());
        assert!(lim.locked_for(other, t0).is_none());
        let later = t0 + LOCK_DURATION + Duration::from_secs(1);
        assert!(lim.locked_for(src, later).is_none());
    }

    #[test]
    fn the_same_wrong_key_repeated_does_not_lock() {
        let lim = Limiter::default();
        let src: IpAddr = "192.168.1.20".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..50 {
            assert!(!lim.record_failure(src, "old-key", t0));
        }
        assert!(lim.locked_for(src, t0).is_none());
    }

    #[test]
    fn failures_outside_the_window_start_over() {
        let lim = Limiter::default();
        let src: IpAddr = "192.168.1.20".parse().unwrap();
        let t0 = Instant::now();
        for i in 0..MAX_DISTINCT_FAILURES - 1 {
            lim.record_failure(src, &format!("a{i}"), t0);
        }
        let later = t0 + FAILURE_WINDOW + Duration::from_secs(1);
        assert!(!lim.record_failure(src, "b", later));
        assert!(lim.locked_for(src, later).is_none());
    }

    #[test]
    fn tracked_sources_are_bounded() {
        let lim = Limiter::default();
        let t0 = Instant::now();
        for i in 0..(MAX_SOURCES + 100) as u32 {
            lim.record_failure(IpAddr::from(i.to_be_bytes()), "x", t0);
        }
        assert!(lim.sources.lock().unwrap().len() <= MAX_SOURCES);
    }
}
