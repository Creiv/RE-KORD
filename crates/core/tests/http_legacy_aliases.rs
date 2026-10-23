//! The `/api/*` routes without `v1` are deprecated aliases: same answer as
//! their `/api/v1` twin, plus `Deprecation` and a `Link` to the successor.

#[path = "http_support/mod.rs"]
mod support;

use axum::http::Method;
use support::{req, Hub};

#[tokio::test]
async fn legacy_aliases_announce_their_successor() {
    let hub = Hub::new("legacy-alias");
    let legacy = hub.send(req(Method::GET, "/api/accounts").build()).await;
    let current = hub.send(req(Method::GET, "/api/v1/accounts").build()).await;
    assert_eq!(legacy.status, current.status);
    assert_eq!(legacy.json()["data"], current.json()["data"]);
    assert_eq!(legacy.header("deprecation").as_deref(), Some("true"));
    assert_eq!(
        legacy.header("link").as_deref(),
        Some("</api/v1/accounts>; rel=\"successor-version\"")
    );
    assert_eq!(current.header("deprecation"), None);
    assert_eq!(current.header("link"), None);

    // `/api/health` is an alias too; `/api/v1` itself is not.
    let health = hub.send(req(Method::GET, "/api/health").build()).await;
    assert_eq!(health.header("deprecation").as_deref(), Some("true"));
    let v1 = hub.send(req(Method::GET, "/api/v1/health").build()).await;
    assert_eq!(v1.header("deprecation"), None);
}
