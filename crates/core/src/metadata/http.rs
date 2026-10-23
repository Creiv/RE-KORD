//! Shared HTTP helpers for the public metadata APIs: one client, JSON GET
//! with 429/503 retries, per-source errors, and a MusicBrainz throttle
//! (their policy is one request per second).

use super::error::SourceError;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// User-Agent of the metadata providers' client (MusicBrainz requires one).
pub fn ua() -> String {
    crate::net::user_agent("studio metadata")
}

/// Shared client (20 s timeout). Falls back to a default client if the
/// builder fails, which only happens without a TLS backend.
pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        crate::net::client(
            "studio metadata",
            Duration::from_secs(10),
            Duration::from_secs(20),
        )
    })
}

async fn mb_throttle() {
    static LAST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let lock = LAST.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut last = lock.lock().await;
    if let Some(t) = *last {
        let gap = Duration::from_millis(1100);
        let elapsed = t.elapsed();
        if elapsed < gap {
            tokio::time::sleep(gap - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

/// GET `url` + `query` as JSON. `Ok(Value::Null)` on 404. Retries twice on
/// 429 / 503. `headers` are added as-is.
pub async fn get_json(
    source: &str,
    url: &str,
    query: &[(&str, &str)],
    headers: Option<reqwest::header::HeaderMap>,
) -> Result<Value, SourceError> {
    let is_mb = url.contains("musicbrainz.org");
    let mut attempt = 0;
    loop {
        if is_mb {
            mb_throttle().await;
        }
        let mut req = client()
            .get(url)
            .query(query)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(h) = &headers {
            req = req.headers(h.clone());
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => {
                return Err(SourceError::new(source, "upstream_timeout", "timeout"))
            }
            Err(e) => {
                return Err(SourceError::new(
                    source,
                    "upstream_unavailable",
                    e.to_string(),
                ))
            }
        };
        let status = res.status().as_u16();
        if (status == 429 || status == 503) && attempt < 2 {
            attempt += 1;
            let wait = if is_mb { 2200 } else { 1100 };
            tokio::time::sleep(Duration::from_millis(wait)).await;
            continue;
        }
        if status == 404 {
            return Ok(Value::Null);
        }
        if status == 429 {
            let code = if source == "discogs" {
                "discogs_rate_limited"
            } else {
                "rate_limited"
            };
            return Err(SourceError::new(source, code, "rate limited"));
        }
        if (status == 401 || status == 403) && source == "discogs" {
            return Err(SourceError::new(
                source,
                "discogs_unauthorized",
                format!("HTTP {status}"),
            ));
        }
        if !res.status().is_success() {
            return Err(SourceError::new(
                source,
                "upstream_unavailable",
                format!("HTTP {status}"),
            ));
        }
        return res
            .json::<Value>()
            .await
            .map_err(|e| SourceError::new(source, "upstream_invalid", e.to_string()));
    }
}
