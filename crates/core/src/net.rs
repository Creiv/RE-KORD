//! Outbound HTTP clients.
//!
//! Every client the hub builds for a fixed, trusted host (metadata providers,
//! GitHub releases, YouTube Music, the public-IP lookups, the preview proxy)
//! comes from here, so the User-Agent carries the running version, timeouts
//! exist everywhere and redirects are capped instead of unbounded. Fetchers
//! that follow URLs chosen by users or by remote data (artwork, podcasts,
//! download thumbnails) keep their own clients: they pin the resolved address
//! or whitelist every redirect hop, which is stricter than this.

use std::time::Duration;

/// Redirect hops a trusted host may take (CDN hops, release assets).
const MAX_REDIRECTS: usize = 5;

/// `RE-KORD/<version> (<what>)`.
pub fn user_agent(what: &str) -> String {
    format!(
        "RE-KORD/{} ({what}; +https://re-kord.com)",
        env!("CARGO_PKG_VERSION")
    )
}

/// A client for a trusted host: `what` names the caller in the User-Agent,
/// `connect` and `total` bound the connection and the whole request.
pub fn client(what: &str, connect: Duration, total: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(user_agent(what))
        .connect_timeout(connect)
        .timeout(total)
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .build()
        // Only fails without a TLS backend, which the bundled rustls rules out.
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_names_the_version_and_the_caller() {
        let ua = user_agent("studio");
        assert!(
            ua.starts_with(&format!("RE-KORD/{} (studio;", env!("CARGO_PKG_VERSION"))),
            "{ua}"
        );
    }
}
