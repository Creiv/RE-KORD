//! Outgoing HTTP for the podcasts module: public hosts only (the SSRF guard of
//! `metadata::artwork`, checked again on every redirect hop and pinned against
//! DNS rebinding), a sane User-Agent, timeouts and size caps.

use super::PodcastError;
use crate::metadata::artwork::{host_name_blocked, ip_blocked};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

/// Redirect hops followed by hand (each one is checked again).
pub const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn user_agent() -> String {
    format!(
        "RE-KORD/{} (podcasts; +https://re-kord.com)",
        env!("CARGO_PKG_VERSION")
    )
}

/// Which addresses outgoing requests may reach. Production: public ones only.
/// Tests add loopback addresses of their local fixtures; nothing outside Rust
/// code (no setting, no environment variable) can widen it.
#[derive(Debug, Clone, Default)]
pub struct NetPolicy {
    pub extra_allowed: Vec<IpAddr>,
    /// Tests only: where the iTunes lookup API is asked instead of Apple.
    #[doc(hidden)]
    pub itunes_lookup: Option<String>,
}

impl NetPolicy {
    fn allows(&self, ip: IpAddr) -> bool {
        !ip_blocked(ip) || self.extra_allowed.contains(&ip)
    }
}

/// http(s), no credentials in the URL.
pub fn parse_public_url(raw: &str) -> Result<url::Url, PodcastError> {
    let raw = raw.trim();
    let raw = if let Some(rest) = raw.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        raw.to_string()
    };
    let url = url::Url::parse(&raw).map_err(|_| PodcastError::InvalidUrl)?;
    check_url_shape(&url)?;
    Ok(url)
}

fn check_url_shape(url: &url::Url) -> Result<(), PodcastError> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(PodcastError::InvalidUrl);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PodcastError::InvalidUrl);
    }
    if url.host().is_none() {
        return Err(PodcastError::InvalidUrl);
    }
    Ok(())
}

/// Resolve `url`'s host to one allowed address to pin the connection to.
pub async fn resolve_allowed(
    url: &url::Url,
    policy: &NetPolicy,
) -> Result<SocketAddr, PodcastError> {
    resolve_allowed_all(url, policy).await.map(|addrs| addrs[0])
}

/// Every address of `url`'s host, all allowed, IPv4 first (hosts with a
/// broken IPv6 route are common; the client tries them in order).
pub async fn resolve_allowed_all(
    url: &url::Url,
    policy: &NetPolicy,
) -> Result<Vec<SocketAddr>, PodcastError> {
    let port = url
        .port_or_known_default()
        .ok_or(PodcastError::InvalidUrl)?;
    let host = match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            let ip = IpAddr::V4(ip);
            return if policy.allows(ip) {
                Ok(vec![SocketAddr::new(ip, port)])
            } else {
                Err(PodcastError::UrlNotAllowed)
            };
        }
        Some(url::Host::Ipv6(ip)) => {
            let ip = IpAddr::V6(ip);
            return if policy.allows(ip) {
                Ok(vec![SocketAddr::new(ip, port)])
            } else {
                Err(PodcastError::UrlNotAllowed)
            };
        }
        Some(url::Host::Domain(d)) => d.to_string(),
        None => return Err(PodcastError::InvalidUrl),
    };
    if host_name_blocked(&host) {
        return Err(PodcastError::UrlNotAllowed);
    }
    let mut addrs: Vec<SocketAddr> = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| PodcastError::Timeout)?
    .map_err(|_| PodcastError::Fetch("could not resolve the host".into()))?
    .collect();
    if addrs.is_empty() {
        return Err(PodcastError::Fetch("could not resolve the host".into()));
    }
    // One internal answer poisons the name (split horizon / rebinding).
    if addrs.iter().any(|a| !policy.allows(a.ip())) {
        return Err(PodcastError::UrlNotAllowed);
    }
    addrs.sort_by_key(|a| a.is_ipv6());
    addrs.dedup();
    Ok(addrs)
}

/// One request, redirects followed by hand: every hop is a public http(s) URL.
pub struct Request<'a> {
    pub url: url::Url,
    pub headers: HeaderMap,
    /// Whole-request timeout (metadata); `None` for streams (they enforce an
    /// idle timeout while reading instead).
    pub timeout: Option<Duration>,
    pub policy: &'a NetPolicy,
}

pub struct Opened {
    pub final_url: url::Url,
    pub response: reqwest::Response,
}

pub async fn open(req: Request<'_>) -> Result<Opened, PodcastError> {
    let mut url = req.url.clone();
    for _ in 0..=MAX_REDIRECTS {
        check_url_shape(&url)?;
        let addrs = resolve_allowed_all(&url, req.policy).await?;
        let mut builder = reqwest::Client::builder()
            .user_agent(user_agent())
            .connect_timeout(CONNECT_TIMEOUT)
            // A system proxy would resolve names itself, past the checks.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none());
        if let Some(t) = req.timeout {
            builder = builder.timeout(t);
        }
        if let Some(domain) = url.domain() {
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        let client = builder
            .build()
            .map_err(|e| PodcastError::Fetch(e.to_string()))?;
        let send = client.get(url.clone()).headers(req.headers.clone()).send();
        let res = match req.timeout {
            Some(_) => send.await,
            // Streams: no whole-request limit, but the answer must start.
            None => tokio::time::timeout(HEADERS_TIMEOUT, send)
                .await
                .map_err(|_| PodcastError::Timeout)?,
        }
        .map_err(classify_reqwest)?;
        // 304 Not Modified is a 3xx too, but it is the answer, not a hop.
        if matches!(res.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let Some(loc) = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return Err(PodcastError::Redirect("redirect without location"));
            };
            url = url
                .join(loc.trim())
                .map_err(|_| PodcastError::Redirect("bad redirect location"))?;
            continue;
        }
        return Ok(Opened {
            final_url: url,
            response: res,
        });
    }
    Err(PodcastError::Redirect("too many redirects"))
}

/// Longest wait for an upstream's response headers on a stream.
const HEADERS_TIMEOUT: Duration = Duration::from_secs(20);

pub fn classify_reqwest(e: reqwest::Error) -> PodcastError {
    if e.is_timeout() {
        return PodcastError::Timeout;
    }
    // Upstream URLs (signed, tokened) stay on the hub. The cause chain
    // ("tcp connect error: Connection refused", "unexpected EOF"…) goes to
    // the log; clients only ever see the error code.
    let e = e.without_url();
    let mut text = e.to_string();
    let mut cause = std::error::Error::source(&e);
    while let Some(c) = cause {
        let part = c.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        cause = c.source();
    }
    PodcastError::Fetch(text)
}

/// Whole-request timeout of one document fetch.
const DOC_TIMEOUT: Duration = Duration::from_secs(20);
/// All attempts of one document fetch end within this, so a list request
/// (which waits 25 s for its sources) still sees the outcome.
const DOC_BUDGET: Duration = Duration::from_secs(24);
/// Pauses before the second and third attempt.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_secs(2)];
/// A retry that could not get at least this long is not worth starting.
const MIN_ATTEMPT: Duration = Duration::from_secs(3);

/// Errors worth another try: the network hiccuped (connect, TLS, a body cut
/// short, DNS), the upstream timed out or was briefly unavailable.
fn is_transient(e: &PodcastError) -> bool {
    matches!(
        e,
        PodcastError::Fetch(_) | PodcastError::Timeout | PodcastError::Http(500 | 502 | 503 | 504)
    )
}

/// Validators of a previous answer, sent as `If-None-Match` / `If-Modified-Since`.
#[derive(Debug, Clone, Default)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[allow(clippy::large_enum_variant)] // short-lived, moved once
pub enum Fetched {
    NotModified,
    Body {
        final_url: url::Url,
        content_type: String,
        body: Vec<u8>,
        validators: Validators,
        /// Station name an Icecast / Shoutcast server announces.
        icy_name: Option<String>,
    },
}

/// GET a document (feed, page, playlist, JSON) up to `max_bytes`. Transient
/// failures are retried twice (after 0.5 s, then 2 s) within `DOC_BUDGET`.
pub async fn fetch_document(
    url: &url::Url,
    policy: &NetPolicy,
    accept: &str,
    max_bytes: usize,
    validators: Option<&Validators>,
) -> Result<Fetched, PodcastError> {
    let started = std::time::Instant::now();
    let mut timeout = DOC_TIMEOUT;
    let mut delays = RETRY_DELAYS.iter();
    loop {
        let err = match fetch_once(url, policy, accept, max_bytes, validators, timeout).await {
            Ok(f) => return Ok(f),
            Err(e) => e,
        };
        let Some(delay) = delays.next().filter(|_| is_transient(&err)) else {
            return Err(err);
        };
        let left = DOC_BUDGET.saturating_sub(started.elapsed() + *delay);
        if left < MIN_ATTEMPT {
            return Err(err);
        }
        tracing::debug!(
            host = url.host_str().unwrap_or(""),
            code = err.code(),
            error = %err,
            "podcast fetch failed, retrying"
        );
        tokio::time::sleep(*delay).await;
        timeout = left.min(DOC_TIMEOUT);
    }
}

async fn fetch_once(
    url: &url::Url,
    policy: &NetPolicy,
    accept: &str,
    max_bytes: usize,
    validators: Option<&Validators>,
    timeout: Duration,
) -> Result<Fetched, PodcastError> {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(accept) {
        headers.insert(reqwest::header::ACCEPT, v);
    }
    if let Some(v) = validators {
        if let Some(etag) = v
            .etag
            .as_deref()
            .and_then(|s| HeaderValue::from_str(s).ok())
        {
            headers.insert(reqwest::header::IF_NONE_MATCH, etag);
        }
        if let Some(lm) = v
            .last_modified
            .as_deref()
            .and_then(|s| HeaderValue::from_str(s).ok())
        {
            headers.insert(reqwest::header::IF_MODIFIED_SINCE, lm);
        }
    }
    let opened = open(Request {
        url: url.clone(),
        headers,
        timeout: Some(timeout),
        policy,
    })
    .await?;
    let res = opened.response;
    if res.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::NotModified);
    }
    if !res.status().is_success() {
        return Err(PodcastError::Http(res.status().as_u16()));
    }
    let header = |name: reqwest::header::HeaderName| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let content_type = header(reqwest::header::CONTENT_TYPE)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let validators = Validators {
        etag: header(reqwest::header::ETAG),
        last_modified: header(reqwest::header::LAST_MODIFIED),
    };
    let icy_name = res
        .headers()
        .get("icy-name")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).trim().to_string())
        .filter(|s| !s.is_empty());
    let body = read_capped(res, max_bytes, &content_type).await?;
    Ok(Fetched::Body {
        final_url: opened.final_url,
        content_type,
        body,
        validators,
        icy_name,
    })
}

/// Read a body up to `max_bytes`. Audio is never read in full (a live stream
/// would never end): only a small head comes back for sniffing.
async fn read_capped(
    res: reqwest::Response,
    max_bytes: usize,
    content_type: &str,
) -> Result<Vec<u8>, PodcastError> {
    let audio = is_audio_type(content_type);
    let cap = if audio { 4096 } else { max_bytes };
    if !audio && res.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(PodcastError::TooLarge);
    }
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(classify_reqwest)?;
        if body.len() + chunk.len() > cap {
            if audio {
                let take = cap - body.len();
                body.extend_from_slice(&chunk[..take]);
                return Ok(body);
            }
            return Err(PodcastError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub fn is_audio_type(content_type: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    (ct.starts_with("audio/") && !is_playlist_type(ct))
        || ct == "application/ogg"
        || ct == "video/mp4"
        || ct == "application/octet-stream+audio"
}

pub fn is_playlist_type(content_type: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    matches!(
        ct,
        "audio/x-mpegurl"
            | "audio/mpegurl"
            | "application/x-mpegurl"
            | "application/vnd.apple.mpegurl"
            | "audio/x-scpls"
            | "application/pls+xml"
            | "audio/scpls"
    )
}

/// GET JSON (RTL API) with the same rules.
pub async fn fetch_json(
    url: &url::Url,
    policy: &NetPolicy,
    max_bytes: usize,
) -> Result<serde_json::Value, PodcastError> {
    match fetch_document(url, policy, "application/json", max_bytes, None).await? {
        Fetched::Body { body, .. } => {
            serde_json::from_slice(&body).map_err(|e| PodcastError::Parse(e.to_string()))
        }
        Fetched::NotModified => Err(PodcastError::Parse("unexpected 304".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn rejects_non_http_and_credentials() {
        assert!(parse_public_url("ftp://example.com/a").is_err());
        assert!(parse_public_url("https://user:pw@example.com/a").is_err());
        assert!(parse_public_url("not a url").is_err());
        assert_eq!(
            parse_public_url("//example.com/feed").unwrap().as_str(),
            "https://example.com/feed"
        );
    }

    #[tokio::test]
    async fn private_and_local_hosts_are_refused() {
        let policy = NetPolicy::default();
        for raw in [
            "http://127.0.0.1/feed",
            "http://10.0.0.5/feed",
            "http://192.168.1.10/feed",
            "http://[::1]/feed",
            "http://localhost/feed",
            "http://printer.local/feed",
            "http://169.254.169.254/latest/meta-data",
        ] {
            let url = parse_public_url(raw).unwrap();
            assert!(
                matches!(
                    resolve_allowed(&url, &policy).await,
                    Err(PodcastError::UrlNotAllowed)
                ),
                "{raw} must be refused"
            );
        }
        let allowed = NetPolicy {
            extra_allowed: vec!["127.0.0.1".parse().unwrap()],
            ..Default::default()
        };
        let url = parse_public_url("http://127.0.0.1:9/feed").unwrap();
        assert!(resolve_allowed(&url, &allowed).await.is_ok());
        let other = parse_public_url("http://127.0.0.2:9/feed").unwrap();
        assert!(resolve_allowed(&other, &allowed).await.is_err());
    }

    #[test]
    fn audio_and_playlist_types() {
        assert!(is_audio_type("audio/mpeg"));
        assert!(is_audio_type("audio/aacp; charset=x"));
        assert!(!is_audio_type("audio/x-mpegurl"));
        assert!(is_playlist_type("audio/x-scpls"));
        assert!(!is_audio_type("text/html"));
    }

    /// A tiny HTTP server: answers the n-th connection with `script[n]`
    /// (`None` = drop the connection without answering), then 200 "ok".
    async fn flaky_server(script: Vec<Option<&'static str>>) -> (url::Url, Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let status = match script.get(n) {
                    Some(None) => continue, // dropped: the client sees EOF
                    Some(Some(status)) => *status,
                    None => "200 OK",
                };
                let body = "<rss><channel><title>ok</title></channel></rss>";
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/rss+xml\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        let url = url::Url::parse(&format!("http://{addr}/feed.xml")).unwrap();
        (url, hits)
    }

    fn local() -> NetPolicy {
        NetPolicy {
            extra_allowed: vec!["127.0.0.1".parse().unwrap()],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn transient_failures_are_retried() {
        // Connection dropped once, then a good answer.
        let (url, hits) = flaky_server(vec![None]).await;
        let got = fetch_document(&url, &local(), "*/*", 1 << 20, None).await;
        assert!(matches!(got, Ok(Fetched::Body { .. })), "recovered");
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // 503 twice, then fine: three attempts in all.
        let (url, hits) = flaky_server(vec![
            Some("503 Service Unavailable"),
            Some("503 Service Unavailable"),
        ])
        .await;
        let got = fetch_document(&url, &local(), "*/*", 1 << 20, None).await;
        assert!(matches!(got, Ok(Fetched::Body { .. })));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn lasting_and_permanent_failures_give_up() {
        // Always failing: three attempts, then the error.
        let (url, hits) = flaky_server(vec![None, None, None, None]).await;
        let got = fetch_document(&url, &local(), "*/*", 1 << 20, None).await;
        assert!(
            matches!(&got, Err(PodcastError::Fetch(_))),
            "{:?}",
            got.err()
        );
        assert_eq!(hits.load(Ordering::SeqCst), 3);

        // A 404 is an answer, not a hiccup: asked once.
        let (url, hits) = flaky_server(vec![Some("404 Not Found")]).await;
        let got = fetch_document(&url, &local(), "*/*", 1 << 20, None).await;
        assert!(matches!(got, Err(PodcastError::Http(404))));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
