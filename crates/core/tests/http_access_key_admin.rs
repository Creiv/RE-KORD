//! The access key set from the admin panel (`/api/v1/system/access-key`):
//! a machine operation that validates the key like `REKORD_ACCESS_KEY`, keeps
//! only its digest in `settings.json`, takes effect at once for every client
//! and can be removed; `REKORD_ACCESS_KEY` locks it.

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use support::{req, From, Hub};

const KEY: &str = "panel-k3y-0123456789abcdefghijklmnopqrstuv";
const OTHER: &str = "second-k3y-zyxwvutsrqponmlkjihgfedcba9876";
const HEADER: &str = "x-rekord-access-key";

#[tokio::test]
async fn panel_sets_replaces_and_removes_the_key() {
    let hub = Hub::new("ak-admin");

    let v = hub
        .send(req(Method::GET, "/api/v1/system/access-key").build())
        .await
        .json();
    assert_eq!(v["data"]["enabled"], false);
    assert_eq!(v["data"]["source"], "off");
    assert_eq!(v["data"]["lockedByEnv"], false);

    // Set: from then on every request needs the key, health included.
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/access-key")
                .from(From::Local)
                .json(json!({ "key": KEY }))
                .build(),
        )
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    let v = res.json();
    assert_eq!(v["data"]["enabled"], true);
    assert_eq!(v["data"]["source"], "settings");
    assert!(
        !String::from_utf8_lossy(&res.body).contains(KEY),
        "answer echoes the key"
    );

    let res = hub
        .send(req(Method::GET, "/api/v1/library/albums").build())
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"], "access_key_required");
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let v = hub
        .send(
            req(Method::GET, "/api/v1/health")
                .header(HEADER, KEY)
                .build(),
        )
        .await
        .json();
    assert_eq!(v["accessKey"], "ok");

    // Only the digest is on disk.
    let settings = std::fs::read_to_string(hub.data.join("settings.json")).unwrap();
    assert!(settings.contains("access_key_sha256"), "{settings}");
    assert!(
        !settings.contains(KEY),
        "settings.json holds the key in clear"
    );

    // Replace: the old key stops working at once.
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/access-key")
                .from(From::Local)
                .header(HEADER, KEY)
                .json(json!({ "key": OTHER }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"], "access_key_invalid");
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, OTHER)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // Remove: open again, and the digest is gone from settings.json.
    let res = hub
        .send(
            req(Method::DELETE, "/api/v1/system/access-key")
                .from(From::Local)
                .header(HEADER, OTHER)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["data"]["enabled"], false);
    let res = hub
        .send(req(Method::GET, "/api/v1/library/albums").build())
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let settings = std::fs::read_to_string(hub.data.join("settings.json")).unwrap();
    assert!(
        !settings.contains("\"access_key_sha256\": \""),
        "{settings}"
    );
}

#[tokio::test]
async fn weak_or_malformed_keys_are_refused_without_echo() {
    let hub = Hub::new("ak-admin-weak");
    for bad in [
        "short",
        &"a".repeat(40),
        &"ab".repeat(20),
        "spaces are not allowed here at all 1234",
    ] {
        let res = hub
            .send(
                req(Method::PUT, "/api/v1/system/access-key")
                    .from(From::Local)
                    .json(json!({ "key": bad }))
                    .build(),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad:?}");
        let v = res.json();
        assert_eq!(v["error"], "access_key_weak", "{bad:?}");
        assert!(
            !v["message"].as_str().unwrap_or("").contains(bad),
            "message echoes the key"
        );
    }
    // Nothing was set.
    let res = hub
        .send(req(Method::GET, "/api/v1/library/albums").build())
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn setting_the_key_is_a_machine_operation() {
    let hub = Hub::new("ak-admin-perm");
    for from in [From::Lan, From::Tunnel] {
        let res = hub
            .send(
                req(Method::PUT, "/api/v1/system/access-key")
                    .from(from)
                    .json(json!({ "key": KEY }))
                    .build(),
            )
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.json()["error"], "forbidden_remote");
    }
    // With remote admin on, the Default account may set it from the LAN.
    hub.set_allow_remote_admin(true);
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/access-key")
                .from(From::Lan)
                .json(json!({ "key": KEY }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn the_environment_variable_locks_the_panel() {
    let hub = Hub::with_access_key("ak-admin-env", KEY);
    let v = hub
        .send(
            req(Method::GET, "/api/v1/system/access-key")
                .header(HEADER, KEY)
                .build(),
        )
        .await
        .json();
    assert_eq!(v["data"]["source"], "env");
    assert_eq!(v["data"]["lockedByEnv"], true);
    for method in [Method::PUT, Method::DELETE] {
        let res = hub
            .send(
                req(method.clone(), "/api/v1/system/access-key")
                    .from(From::Local)
                    .header(HEADER, KEY)
                    .json(json!({ "key": OTHER }))
                    .build(),
            )
            .await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{method}");
        assert_eq!(res.json()["error"], "access_key_from_env");
    }
    // Still the environment's key.
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/albums")
                .header(HEADER, KEY)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn a_saved_digest_is_loaded_at_startup() {
    // Set the key on one hub, then start a second hub on the same data dir.
    let hub = Hub::new("ak-admin-restart");
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/access-key")
                .from(From::Local)
                .json(json!({ "key": KEY }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let digest = hub
        .state
        .config
        .lock()
        .unwrap()
        .read_access_key_digest()
        .expect("digest saved");
    let gate = rekord_core::access_key::AccessGate::from_digest_hex(&digest).unwrap();
    assert!(gate.matches(KEY));
    assert!(!gate.matches(OTHER));
    assert!(rekord_core::access_key::AccessGate::from_digest_hex("nope").is_err());
}
