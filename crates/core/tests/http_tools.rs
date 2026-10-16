//! Tool versions in diagnostics (age / stale flag), cached so repeated calls
//! never re-run `--version` (perf QA item 8); remote-access status stays
//! fast; the yt-dlp update is a machine operation.

#![cfg(unix)]

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};
use support::{req, From, Hub};

#[tokio::test]
async fn diagnostics_reports_ytdlp_age_and_caches_probes() {
    let hub = Hub::new("tools-diag");
    // A configured yt-dlp that counts its own `--version` runs.
    let counter = hub.base.join("probes");
    let path = hub.base.join("bin/yt-dlp");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\necho x >> '{}'\necho 2099.12.31\n",
            counter.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    hub.state.config.lock().unwrap().ytdlp_path = Some(path.clone());

    let res = hub
        .send(req(Method::GET, "/api/v1/diagnostics").build())
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let y = res.json()["data"]["binaries"]["ytdlp"].clone();
    assert_eq!(y["available"], true);
    assert_eq!(y["source"], "config");
    assert_eq!(y["version"], "2099.12.31");
    assert_eq!(y["releaseDate"], "2099-12-31");
    assert_eq!(y["stale"], false);
    assert_eq!(y["staleAfterDays"], 60);
    assert!(y["ageDays"].as_i64().unwrap() < 0);
    let probes_after_first = std::fs::read_to_string(&counter).unwrap().lines().count();
    assert_eq!(probes_after_first, 1);

    let t = Instant::now();
    for _ in 0..5 {
        let res = hub
            .send(req(Method::GET, "/api/v1/diagnostics").build())
            .await;
        assert_eq!(res.status, StatusCode::OK);
    }
    let per_call = t.elapsed() / 5;
    assert!(per_call < Duration::from_millis(200), "{per_call:?}");
    let probes = std::fs::read_to_string(&counter).unwrap().lines().count();
    assert_eq!(probes, 1, "cached: no new --version runs");
}

#[tokio::test]
async fn download_preset_names_the_js_runtime_without_its_path() {
    let hub = Hub::new("tools-preset");
    let res = hub
        .send(req(Method::GET, "/api/v1/download-preset").build())
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let js = res.json()["data"]["jsRuntime"].clone();
    assert!(js.is_object(), "{js}");
    assert!(js.get("available").is_some(), "{js}");
    assert!(js.get("path").is_none(), "path leaked: {js}");
}

#[tokio::test]
async fn stale_ytdlp_is_flagged() {
    let hub = Hub::new("tools-stale");
    let path = hub.base.join("bin/yt-dlp");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "#!/bin/sh\necho 2001.01.01\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Only candidate that can win if every other copy is newer: just check
    // the age logic through the status of the configured copy.
    let r = rekord_core::tools::resolve_with(
        rekord_core::tools::Tool::Ytdlp,
        vec![rekord_core::tools::Candidate {
            path: path.clone(),
            source: "config",
        }],
        |p| rekord_core::tools::probe_version_blocking(rekord_core::tools::Tool::Ytdlp, p),
    );
    let v = rekord_core::tools::status_json(&r);
    assert_eq!(v["stale"], true);
    assert!(v["ageDays"].as_i64().unwrap() > 60);
}

#[tokio::test]
async fn remote_access_status_is_fast_once_warm() {
    let hub = Hub::new("tools-remote");
    let _ = hub
        .send(req(Method::GET, "/api/v1/remote-access").build())
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let t = Instant::now();
    let res = hub
        .send(req(Method::GET, "/api/v1/remote-access").build())
        .await;
    let took = t.elapsed();
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.json()["data"].get("cloudflaredAvailable").is_some());
    // Generous bound for debug builds on a busy CI box; typically < 1 ms.
    assert!(took < Duration::from_millis(50), "{took:?}");
}

#[tokio::test]
async fn ytdlp_update_requires_machine_rights() {
    let hub = Hub::new("tools-update");
    let res = hub
        .send(
            req(Method::POST, "/api/v1/tools/ytdlp/update")
                .from(From::Lan)
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.json()["error"], "forbidden_remote");
}
