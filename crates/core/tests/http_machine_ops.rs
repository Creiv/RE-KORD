//! Machine-operation guard (legacy `requestAccess.mjs` `ADMIN_MUTATION_PATHS`):
//! allowed from the hub machine, refused from LAN and through the Cloudflare
//! tunnel (even though cloudflared connects from loopback) unless
//! `allow_remote_admin` is on. Personal-data routes stay open to remote clients.

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use support::{req, From, Hub, Req};

/// A named request factory (requests are not `Clone`).
type Case = (&'static str, Box<dyn Fn() -> Req>);

fn guarded_requests() -> Vec<Case> {
    vec![
        (
            "jobs cancel",
            Box::new(|| req(Method::POST, "/api/v1/jobs/nope/cancel")),
        ),
        (
            "jobs clear",
            Box::new(|| req(Method::DELETE, "/api/v1/jobs")),
        ),
        (
            "library probe",
            Box::new(|| req(Method::POST, "/api/v1/library/probe")),
        ),
        (
            "errors clear",
            Box::new(|| req(Method::DELETE, "/api/v1/diagnostics/errors")),
        ),
        (
            "backup download",
            Box::new(|| req(Method::GET, "/api/v1/backup/kord-data")),
        ),
        (
            "mkdir",
            Box::new(|| req(Method::POST, "/api/v1/fs/mkdir").json(json!({ "name": "New" }))),
        ),
        (
            "download",
            Box::new(|| {
                req(Method::POST, "/api/v1/download").json(json!({
                    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "downloadId": "6f1c2a8e-3b7d-4c1e-9a2b-1d2e3f4a5b6c",
                }))
            }),
        ),
        (
            "download cancel",
            Box::new(|| {
                req(Method::POST, "/api/v1/download-cancel")
                    .json(json!({ "downloadId": "6f1c2a8e-3b7d-4c1e-9a2b-1d2e3f4a5b6c" }))
            }),
        ),
        (
            "artwork apply",
            Box::new(|| {
                req(Method::POST, "/api/v1/artwork/apply")
                    .json(json!({ "albumPath": "A/B", "imageUrl": "https://example.com/x.jpg" }))
            }),
        ),
        (
            "album info save",
            Box::new(|| {
                req(Method::POST, "/api/v1/album-info/save")
                    .json(json!({ "albumPath": "A/B", "patch": {} }))
            }),
        ),
        (
            "track info save",
            Box::new(|| {
                req(Method::POST, "/api/v1/track-info/save")
                    .json(json!({ "relPath": "A/B/01.mp3", "patch": { "title": "x" } }))
            }),
        ),
        (
            "prune orphans",
            Box::new(|| {
                req(Method::POST, "/api/v1/track-info/prune-orphans")
                    .json(json!({ "albumPath": "A/B" }))
            }),
        ),
        (
            "sanitize titles",
            Box::new(|| {
                req(Method::POST, "/api/v1/studio/sanitize-track-titles")
                    .json(json!({ "scope": "album", "albumPath": "A/B" }))
            }),
        ),
        (
            "discogs apply",
            Box::new(|| {
                req(Method::POST, "/api/v1/discogs/apply-release")
                    .json(json!({ "albumPath": "A/B", "releaseId": 1 }))
            }),
        ),
        (
            "entity info save",
            Box::new(|| {
                req(Method::POST, "/api/v1/entity-info/save").json(json!({ "artist": "A" }))
            }),
        ),
        (
            "account create",
            Box::new(|| req(Method::POST, "/api/v1/accounts").json(json!({ "name": "Ospite" }))),
        ),
    ]
}

#[tokio::test]
async fn remote_and_tunnel_callers_are_refused() {
    let hub = Hub::new("mop-remote");
    hub.file("A/B/01.mp3", b"x");
    for from in [From::Lan, From::Tunnel] {
        for (name, make) in guarded_requests() {
            let res = hub.send(make().from(from).build()).await;
            assert_eq!(res.status, StatusCode::FORBIDDEN, "{name}");
        }
    }
}

#[tokio::test]
async fn local_caller_passes_the_guard() {
    let hub = Hub::new("mop-local");
    hub.file("A/B/01.mp3", b"x");
    for (name, make) in guarded_requests() {
        if name == "download" || name == "artwork apply" || name == "discogs apply" {
            // These would reach yt-dlp / the network once authorised.
            continue;
        }
        let res = hub.send(make().from(From::Local).build()).await;
        assert_ne!(
            res.status,
            StatusCode::FORBIDDEN,
            "{name}: {:?}",
            res.json()
        );
    }
}

#[tokio::test]
async fn allow_remote_admin_opens_machine_ops_to_lan_and_tunnel() {
    let hub = Hub::new("mop-allow");
    hub.set_allow_remote_admin(true);
    for from in [From::Lan, From::Tunnel] {
        let res = hub
            .send(
                req(Method::POST, "/api/v1/jobs/nope/cancel")
                    .from(from)
                    .build(),
            )
            .await;
        assert_eq!(
            res.status,
            StatusCode::NOT_FOUND,
            "guard passed, job unknown"
        );
        let res = hub
            .send(
                req(Method::POST, "/api/v1/fs/mkdir")
                    .from(from)
                    .json(json!({ "name": "Remote" }))
                    .build(),
            )
            .await;
        assert!(res.status != StatusCode::FORBIDDEN);
    }
    assert!(hub.root.join("Remote").is_dir());
    // Turning the toggle on remotely stays a local-only action.
    let res = hub
        .send(
            req(Method::PUT, "/api/v1/system/machine-access")
                .from(From::Lan)
                .json(json!({ "enabled": true }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn spoofed_proxy_headers_only_downgrade() {
    let hub = Hub::new("mop-spoof");
    let res = hub
        .send(
            req(Method::DELETE, "/api/v1/jobs")
                .header("x-forwarded-for", "8.8.8.8")
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // A LAN client cannot claim to be local through the Host header.
    let res = hub
        .send(
            req(Method::DELETE, "/api/v1/jobs")
                .from(From::Lan)
                .header("host", "127.0.0.1:7420")
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn non_default_account_cannot_run_machine_ops_but_can_manage_accounts_locally() {
    let hub = Hub::new("mop-account");
    let res = hub
        .send(
            req(Method::POST, "/api/v1/accounts")
                .json(json!({ "name": "Ospite" }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let guest = res.json()["data"]["createdAccountId"]
        .as_str()
        .unwrap()
        .to_string();

    let res = hub
        .send(
            req(Method::DELETE, "/api/v1/jobs")
                .header("x-rekord-account-id", &guest)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    // Legacy: any local account may rename accounts.
    let res = hub
        .send(
            req(Method::PUT, &format!("/api/v1/accounts/{guest}"))
                .header("x-rekord-account-id", &guest)
                .json(json!({ "name": "Ospite 2" }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // Remote: registry changes are refused.
    let res = hub
        .send(
            req(Method::DELETE, &format!("/api/v1/accounts/{guest}"))
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn profile_export_is_own_account_only_from_remote() {
    let hub = Hub::new("mop-export");
    let res = hub
        .send(
            req(Method::POST, "/api/v1/accounts")
                .json(json!({ "name": "A" }))
                .build(),
        )
        .await;
    let guest = res.json()["data"]["createdAccountId"]
        .as_str()
        .unwrap()
        .to_string();
    let own = hub
        .send(
            req(Method::GET, &format!("/api/v1/accounts/{guest}/export"))
                .from(From::Lan)
                .header("x-rekord-account-id", &guest)
                .build(),
        )
        .await;
    assert_eq!(own.status, StatusCode::OK);
    let other = hub
        .send(
            req(Method::GET, "/api/v1/accounts/default/export")
                .from(From::Lan)
                .header("x-rekord-account-id", &guest)
                .build(),
        )
        .await;
    assert_eq!(other.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn personal_routes_stay_open_to_remote_clients() {
    let hub = Hub::new("mop-personal");
    let res = hub
        .send(
            req(Method::PATCH, "/api/v1/user-state")
                .from(From::Tunnel)
                .json(json!({ "trackMoods": { "A/B/01.mp3": ["chill_relax"] } }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    // Mood-only track-info patch keeps the legacy carve-out.
    hub.file("A/B/01.mp3", b"x");
    let res = hub
        .send(
            req(Method::POST, "/api/v1/track-info/save")
                .from(From::Lan)
                .json(json!({ "relPath": "A/B/01.mp3", "patch": { "moods": ["chill_relax"] } }))
                .build(),
        )
        .await;
    assert_ne!(res.status, StatusCode::FORBIDDEN);
    // ...but it must not write library metadata for an unprivileged caller.
    assert!(!hub.root.join("A/B/kord-trackinfo.json").exists());
    let res = hub
        .send(
            req(Method::POST, "/api/v1/track-info/save")
                .from(From::Tunnel)
                .json(json!({ "relPath": "A/B/01.mp3", "patch": { "mood": "x" } }))
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(!hub.root.join("A/B/kord-trackinfo.json").exists());
}

/// A negative grace typed in the admin form is clamped (envelope answer,
/// not a bare 422), and what is saved is what the manager runs.
#[tokio::test]
async fn power_grace_is_clamped_and_applied_as_saved() {
    let hub = Hub::new("powergrace");
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/system/power")
                .json(json!({ "graceMinutes": -5 }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let saved = hub.state.config.lock().unwrap().power;
    assert_eq!(
        saved.grace_minutes,
        rekord_core::config::PowerSettings::MIN_GRACE_MINUTES
    );
    assert_eq!(hub.state.power.settings(), saved);
}
