//! `REKORD_ACCESS_KEY`: with a key every `/api` and `/media` request must
//! present it (header or `accessKey` query), health answers a minimal body
//! without it, wrong keys lock their source briefly, and the local / remote
//! rules still apply on top.

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use support::{req, From, Hub, Resp};

const KEY: &str = "k3y-0123456789abcdefghijklmnopqrstuvwxyz";
const HEADER: &str = "x-rekord-access-key";

fn assert_no_key(res: &Resp) {
    let body = String::from_utf8_lossy(&res.body);
    assert!(!body.contains(KEY), "response body echoes the key");
    for (name, value) in &res.headers {
        assert!(
            !value.to_str().unwrap_or("").contains(KEY),
            "header {name} echoes the key"
        );
    }
}

#[tokio::test]
async fn without_a_configured_key_nothing_changes() {
    let hub = Hub::new("ak-off");
    let res = hub
        .send(req(Method::GET, "/api/v1/library/albums").build())
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let v = hub
        .send(req(Method::GET, "/api/v1/health").build())
        .await
        .json();
    assert_eq!(v["accessKey"], "off");
    assert!(v["version"].is_string());
    // A stray key is ignored, not refused.
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, "whatever")
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn api_and_media_require_the_key_including_legacy_aliases() {
    let hub = Hub::with_access_key("ak-required", KEY);
    hub.file("A/B/t.flac", &[7u8; 64]);
    for path in [
        "/api/v1/library/albums",
        "/api/v1/accounts",
        "/api/accounts",
        "/api/user-state",
        "/api/v1/user-state",
        "/api/backup/kord-data",
        "/api/v1/system/machine-access",
        "/api/v1/media/A/B/t.flac",
        "/media/A/B/t.flac",
        "/api/v1/does-not-exist",
        "/api",
    ] {
        for from in [From::Local, From::Lan, From::Tunnel] {
            let res = hub.send(req(Method::GET, path).from(from).build()).await;
            assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(res.json()["error"], "access_key_required", "{path}");
            assert_eq!(res.header("cache-control").as_deref(), Some("no-store"));
            assert!(res.header("www-authenticate").is_none());
        }
    }
    let res = hub
        .send(
            req(Method::POST, "/api/v1/playlists")
                .json(serde_json::json!({ "name": "x" }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn header_and_query_keys_are_accepted() {
    let hub = Hub::with_access_key("ak-accept", KEY);
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_no_key(&res);
    let res = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/library/albums?limit=1&accessKey={KEY}"),
            )
            .from(From::Lan)
            .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_no_key(&res);
    // Legacy alias with the key.
    let res = hub
        .send(
            req(Method::GET, "/api/accounts")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn media_ranges_work_with_the_key_in_the_query() {
    let hub = Hub::with_access_key("ak-range", KEY);
    let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
    hub.file("A/B/t.flac", &data);
    let uri = format!("/media/A/B/t.flac?accessKey={KEY}");
    let res = hub
        .send(
            req(Method::GET, &uri)
                .header("range", "bytes=100-199")
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        res.header("content-range").as_deref(),
        Some("bytes 100-199/1000")
    );
    assert_eq!(res.body, data[100..200]);
    let res = hub
        .send(req(Method::GET, &uri).header("range", "bytes=-10").build())
        .await;
    assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(res.body, data[990..]);
}

#[tokio::test]
async fn health_is_minimal_without_the_key_and_full_with_it() {
    let hub = Hub::with_access_key("ak-health", KEY);
    for path in ["/api/v1/health", "/api/health"] {
        let res = hub
            .send(req(Method::GET, path).from(From::Lan).build())
            .await;
        assert_eq!(res.status, StatusCode::OK);
        let v = res.json();
        assert_eq!(v["service"], "RE-KORD");
        assert_eq!(v["accessKey"], "required");
        assert!(v["apiVersion"].is_number());
        assert!(v["minClientVersion"].is_string());
        for hidden in ["version", "modules", "transcode", "scanning"] {
            assert!(v.get(hidden).is_none(), "{hidden} leaked");
        }
    }
    let res = hub
        .send(
            req(Method::GET, "/api/v1/health")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    let v = res.json();
    assert_eq!(v["accessKey"], "ok");
    assert!(v["version"].is_string());
    assert!(v["modules"].is_array() || v["modules"].is_object());
    assert_no_key(&res);
    // A wrong key on health is refused: that is how clients validate a key.
    let res = hub
        .send(
            req(Method::GET, "/api/v1/health")
                .header(HEADER, "nope")
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"], "access_key_invalid");
}

#[tokio::test]
async fn ui_and_unprotected_paths_do_not_ask_for_a_key() {
    let hub = Hub::with_access_key("ak-ui", KEY);
    for path in [
        "/",
        "/index.html",
        "/admin/",
        "/assets/x.js",
        "/apiary",
        "/mediax",
    ] {
        let res = hub.send(req(Method::GET, path).build()).await;
        assert_ne!(res.status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn preflight_needs_no_key_and_refusals_keep_cors() {
    let hub = Hub::with_access_key("ak-cors", KEY);
    let res = hub
        .send(
            req(Method::OPTIONS, "/api/v1/user-state")
                .header("origin", "http://tauri.localhost")
                .header("access-control-request-method", "PATCH")
                .header(
                    "access-control-request-headers",
                    "content-type,x-rekord-account-id,x-rekord-access-key",
                )
                .from(From::Lan)
                .build(),
        )
        .await;
    assert!(res.status.is_success(), "{}", res.status);
    let allowed = res
        .header("access-control-allow-headers")
        .unwrap_or_default();
    assert!(allowed.contains("x-rekord-access-key"), "{allowed}");

    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header("origin", "http://tauri.localhost")
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.header("access-control-allow-origin").as_deref(),
        Some("http://tauri.localhost")
    );
    assert_eq!(
        res.header("referrer-policy").as_deref(),
        Some("no-referrer")
    );
}

#[tokio::test]
async fn the_key_is_a_layer_in_front_of_local_and_remote_rules() {
    let hub = Hub::with_access_key("ak-perm", KEY);
    let get = |from: From| {
        req(Method::GET, "/api/v1/system/machine-access")
            .header(HEADER, KEY)
            .from(from)
            .build()
    };
    let v = hub.send(get(From::Local)).await.json();
    assert_eq!(v["data"]["canManageMachine"], true);
    let v = hub.send(get(From::Lan)).await.json();
    assert_eq!(v["data"]["canManageMachine"], false);
    assert_eq!(v["data"]["libraryDeniedReason"], "forbidden_remote");
    let v = hub.send(get(From::Tunnel)).await.json();
    assert_eq!(v["data"]["canManageLibrary"], false);

    // A machine operation from the LAN with the right key is still refused.
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/machine-access")
                .header(HEADER, KEY)
                .json(serde_json::json!({ "enabled": true }))
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.json()["error"], "forbidden_remote");
}

async fn wrong(hub: &Hub, from: From, key: &str, extra: Option<(&str, &str)>) -> Resp {
    let mut r = req(Method::GET, "/api/v1/library/albums")
        .header(HEADER, key)
        .from(from);
    if let Some((k, v)) = extra {
        r = r.header(k, v);
    }
    hub.send(r.build()).await
}

#[tokio::test]
async fn distinct_wrong_keys_lock_wrong_keys_but_never_the_right_one() {
    let hub = Hub::with_access_key("ak-lock", KEY);
    for i in 0..4 {
        let res = wrong(&hub, From::Lan, &format!("guess-{i}"), None).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        assert_eq!(res.json()["error"], "access_key_invalid");
        assert_no_key(&res);
    }
    let res = wrong(&hub, From::Lan, "guess-4", None).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.json()["error"], "access_key_rate_limited");
    let retry: u64 = res.header("retry-after").unwrap().parse().unwrap();
    assert!((1..=60).contains(&retry), "{retry}");
    // Locked: the right key still gets in (one source can be many clients).
    let res = wrong(&hub, From::Lan, KEY, None).await;
    assert_eq!(res.status, StatusCode::OK);
    // ...and does not lift the lock: wrong keys, old or new, stay refused.
    for guess in ["guess-0", "guess-new"] {
        let res = wrong(&hub, From::Lan, guess, None).await;
        assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{guess}");
        assert_eq!(res.json()["error"], "access_key_rate_limited");
        assert!(res.header("retry-after").is_some());
        assert_no_key(&res);
    }
    // Health, the key check of the clients, follows the same rule.
    let res = hub
        .send(
            req(Method::GET, "/api/v1/health")
                .header(HEADER, KEY)
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.json()["accessKey"], "ok");
    // Other sources are unaffected.
    let res = wrong(&hub, From::Local, KEY, None).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = wrong(&hub, From::Tunnel, KEY, None).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn a_stale_key_repeated_does_not_lock() {
    let hub = Hub::with_access_key("ak-stale", KEY);
    for _ in 0..40 {
        let res = wrong(&hub, From::Lan, "the-old-key", None).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
    let res = wrong(&hub, From::Lan, KEY, None).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn forged_forwarding_headers_cannot_dodge_the_lock() {
    let hub = Hub::with_access_key("ak-spoof", KEY);
    // A LAN client inventing a new X-Forwarded-For / CF-Connecting-IP each time.
    for i in 0..5 {
        let ip = format!("10.0.0.{i}");
        wrong(
            &hub,
            From::Lan,
            &format!("g{i}"),
            Some(("x-forwarded-for", &ip)),
        )
        .await;
    }
    for (name, value) in [
        ("x-forwarded-for", "10.9.9.9"),
        ("cf-connecting-ip", "10.8.8.8"),
    ] {
        let res = wrong(&hub, From::Lan, "g9", Some((name, value))).await;
        assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{name}");
    }
    // The right key still gets in, with or without the forged header.
    let res = wrong(&hub, From::Lan, KEY, Some(("x-forwarded-for", "10.9.9.9"))).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn behind_a_proxy_every_client_shares_the_peer_source() {
    let hub = Hub::with_access_key("ak-proxy", KEY);
    // Reverse proxy on the hub machine: peer 127.0.0.1; the headers say who the
    // client is, but they are ignored, so all its clients are one source.
    for i in 0..5 {
        wrong(
            &hub,
            From::Local,
            &format!("g{i}"),
            Some(("x-forwarded-for", "203.0.113.7")),
        )
        .await;
    }
    for (name, value) in [
        ("x-forwarded-for", "203.0.113.8"),
        ("cf-connecting-ip", "203.0.113.9"),
    ] {
        let res = wrong(&hub, From::Local, "g-new", Some((name, value))).await;
        assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{name}");
    }
    // The tunnel arrives from loopback too: same source, same lock for wrong keys.
    let res = wrong(&hub, From::Tunnel, "g-tunnel", None).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    // Every one of those clients still gets in with the right key.
    for extra in [
        Some(("x-forwarded-for", "203.0.113.7")),
        Some(("x-forwarded-for", "203.0.113.8")),
        None,
    ] {
        let res = wrong(&hub, From::Local, KEY, extra).await;
        assert_eq!(res.status, StatusCode::OK, "{extra:?}");
    }
    let res = wrong(&hub, From::Tunnel, KEY, None).await;
    assert_eq!(res.status, StatusCode::OK);
}
