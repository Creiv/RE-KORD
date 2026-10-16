//! `/api/v1/library/embedded`: settings, the "re-read" action and the
//! backfill job (progress in `/jobs`, embedded fields in the library API).

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use rekord_core::scan::ScanMode;
use std::fs;
use std::time::Duration;
use support::{req, From, Hub};

/// WMA with tags (ffmpeg reads them). Built into the test binary, so the test
/// needs nothing from the source tree while it runs: copying the fixture
/// from there once failed with NotFound while the working tree was being
/// rewritten by another process.
const TAGGED_WMA: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/embedded/tagged.wma"
));

/// ID3v2.3 MP3 with a title and a genre (silent audio frames).
fn mp3(title: &str, genre: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, text) in [("TIT2", title), ("TCON", genre)] {
        let mut payload = vec![0u8];
        payload.extend_from_slice(text.as_bytes());
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&payload);
    }
    let size = body.len() as u32;
    let mut out = b"ID3\x03\x00\x00".to_vec();
    out.extend_from_slice(&[
        ((size >> 21) & 0x7f) as u8,
        ((size >> 14) & 0x7f) as u8,
        ((size >> 7) & 0x7f) as u8,
        (size & 0x7f) as u8,
    ]);
    out.extend_from_slice(&body);
    for _ in 0..8 {
        out.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        out.extend_from_slice(&[0u8; 417 - 4]);
    }
    out
}

async fn status(hub: &Hub) -> serde_json::Value {
    let r = hub
        .send(req(Method::GET, "/api/v1/library/embedded").build())
        .await;
    assert_eq!(r.status, StatusCode::OK);
    r.json()["data"].clone()
}

/// Wait for the backfill job to finish and return its `/jobs` entry.
async fn finished_job(hub: &Hub) -> serde_json::Value {
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let s = status(hub).await;
        if s["running"] == false && s["pendingTracks"] == 0 && s["pendingAlbums"] == 0 {
            let jobs = hub
                .send(req(Method::GET, "/api/v1/jobs").build())
                .await
                .json();
            if let Some(job) = jobs["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["kind"] == "embeddedTags" && j["status"] != "running")
            {
                return job.clone();
            }
        }
    }
    panic!("embedded backfill did not finish");
}

fn track<'a>(tracks: &'a serde_json::Value, file: &str) -> &'a serde_json::Value {
    tracks["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["file_name"] == file)
        .unwrap_or_else(|| panic!("{file} not in {tracks}"))
}

#[tokio::test]
async fn settings_reread_and_job_progress() {
    let hub = Hub::new("embedded");
    hub.file("A/B/01 - one.mp3", &mp3("Tagged One", "Dub"));
    hub.file("A/B/02 - two.wma", TAGGED_WMA);
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();

    let s = status(&hub).await;
    assert_eq!(s["enabled"], true);
    assert_eq!(s["priority"], "studio");
    assert_eq!(s["pendingTracks"], 0);

    let lib = hub
        .send(req(Method::GET, "/api/v1/library?limit=50").build())
        .await
        .json();
    let one = track(&lib, "01 - one.mp3");
    assert_eq!(one["title"], "Tagged One");
    assert!(one["embedded_fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "genre"));

    // A person types a title in Studio.
    hub.state
        .db
        .save_track_fields("A/B/01 - one.mp3", Some("Typed"), None, None, None)
        .unwrap();

    // Remote clients may not change the setting.
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/library/embedded")
                .from(From::Lan)
                .json(serde_json::json!({ "enabled": false }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/library/embedded")
                .json(serde_json::json!({ "priority": "sideways" }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Turning it off re-reads the library: tag values give way to the file
    // names, typed values stay.
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/library/embedded")
                .json(serde_json::json!({ "enabled": false }))
                .build(),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["data"]["enabled"], false);
    let job = finished_job(&hub).await;
    assert_eq!(job["detailCode"], "embeddedTags.done");
    assert_eq!(job["titleCode"], "embeddedTags.title");
    assert_eq!(job["params"]["tracks"], 2);
    let lib = hub
        .send(req(Method::GET, "/api/v1/library?limit=50").build())
        .await
        .json();
    assert_eq!(track(&lib, "01 - one.mp3")["title"], "Typed");
    let two = track(&lib, "02 - two.wma");
    assert_eq!(two["title"], "two");
    assert!(two.get("genres").unwrap().as_array().unwrap().is_empty());
    let saved = fs::read_to_string(hub.data.join("settings.json")).unwrap();
    assert!(saved.contains("\"embedded_metadata\""), "{saved}");

    // Back on, then the maintenance action: everything is read again.
    hub.send(
        req(Method::PUT, "/api/v1/library/embedded")
            .json(serde_json::json!({ "enabled": true }))
            .build(),
    )
    .await;
    finished_job(&hub).await;
    let r = hub
        .send(
            req(Method::POST, "/api/v1/library/embedded/reread")
                .json(serde_json::json!({ "overrideStudio": true }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    // "Replace Studio too" only applies with the embedded priority.
    assert_eq!(r.json()["data"]["overrideStudio"], false);
    finished_job(&hub).await;
    let lib = hub
        .send(req(Method::GET, "/api/v1/library?limit=50").build())
        .await
        .json();
    assert_eq!(track(&lib, "01 - one.mp3")["title"], "Typed");
    let ffmpeg = rekord_core::tools::resolve_blocking(
        rekord_core::tools::Tool::Ffmpeg,
        &rekord_core::tools::ToolContext::default(),
    );
    if ffmpeg.available {
        assert_eq!(track(&lib, "02 - two.wma")["title"], "Wma Title");
    }

    // Embedded priority + explicit override: the tag wins over the typed title.
    hub.send(
        req(Method::PUT, "/api/v1/library/embedded")
            .json(serde_json::json!({ "priority": "embedded" }))
            .build(),
    )
    .await;
    finished_job(&hub).await;
    let r = hub
        .send(
            req(Method::POST, "/api/v1/library/embedded/reread")
                .json(serde_json::json!({ "overrideStudio": true }))
                .build(),
        )
        .await;
    assert_eq!(r.json()["data"]["overrideStudio"], true);
    finished_job(&hub).await;
    let lib = hub
        .send(req(Method::GET, "/api/v1/library?limit=50").build())
        .await
        .json();
    assert_eq!(track(&lib, "01 - one.mp3")["title"], "Tagged One");
    assert_eq!(status(&hub).await["overrideStudio"], false);
}

/// A scan whose request goes away (closed admin tab: the handler's future
/// is dropped) still releases the scan lock and its sleep-prevention
/// activity when the work ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_scan_request_still_releases_the_scan_lock() {
    let hub = Hub::new("scanlease");
    for a in 0..30 {
        for t in 0..40 {
            let p = hub.root.join(format!("Artist {a}/Album/{t:02} - x.mp3"));
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, mp3(&format!("T{t}"), "Rock")).unwrap();
        }
    }
    let state = hub.state.clone();
    let task = tokio::spawn(async move {
        let _ = state
            .run_scan(rekord_core::scan::ScanOptions {
                mode: rekord_core::scan::ScanMode::Full,
                ..Default::default()
            })
            .await;
    });
    for _ in 0..200 {
        if hub.state.is_scanning() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    task.abort();
    let _ = task.await;
    for _ in 0..600 {
        if !hub.state.is_scanning() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(!hub.state.is_scanning(), "scan lock stuck");
    assert_eq!(hub.state.power.status().active_jobs, 0, "activity stuck");
}
