//! Podcasts module: feed parsing on recorded fixtures (no network), and the
//! HTTP surface against a local fixture server — module off means no
//! endpoints, on-demand fetch with TTL and conditional requests, the proxy
//! (Range pass-through, allowlist, SSRF re-check on redirects), live streams.

#[path = "http_support/mod.rs"]
mod support;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rekord_core::podcasts::feed::parse_feed;
use rekord_core::podcasts::net::NetPolicy;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use support::{req, From, Hub};

const ITUNES: &[u8] = include_bytes!("fixtures/podcasts/itunes_feed.xml");
const ATOM: &[u8] = include_bytes!("fixtures/podcasts/atom_feed.xml");
const LATIN1: &[u8] = include_bytes!("fixtures/podcasts/latin1_feed.xml");

fn base(u: &str) -> url::Url {
    url::Url::parse(u).unwrap()
}

#[test]
fn rss_with_itunes_quirks() {
    let feed = parse_feed(ITUNES, &base("https://news.example/feed.xml"), 10).unwrap();
    assert_eq!(feed.title.as_deref(), Some("Notizie & Approfondimenti"));
    assert_eq!(
        feed.artwork_url.as_deref(),
        Some("https://cdn.news.example/show-3000.png")
    );
    let titles: Vec<&str> = feed.episodes.iter().map(|e| e.title.as_str()).collect();
    // Newest first, duplicate guid dropped, item without enclosure skipped.
    assert_eq!(
        titles,
        vec![
            "Edizione delle 15 & meteo",
            "Edizione delle 14",
            "Edizione delle 13",
            "Video only, no audio type"
        ]
    );
    let ep15 = &feed.episodes[0];
    assert_eq!(ep15.published_at.as_deref(), Some("2026-10-07T13:00:00Z"));
    assert_eq!(
        ep15.media_url.as_deref(),
        Some("https://news.example/media/ep15.m4a?token=a&b=2")
    );
    assert_eq!(ep15.duration_secs, Some(312));
    assert_eq!(
        ep15.artwork_url.as_deref(),
        Some("https://cdn.news.example/ep15.jpg")
    );
    assert_eq!(ep15.mime.as_deref(), Some("audio/x-m4a"));
    let ep14 = &feed.episodes[1];
    assert_eq!(
        ep14.media_url.as_deref(),
        Some("https://news.example/ep14.mp3")
    );
    assert_eq!(ep14.duration_secs, None, "missing duration stays unknown");
    let ep13 = &feed.episodes[2];
    assert_eq!(ep13.duration_secs, Some(252), "HH:MM:SS");
    assert_eq!(
        ep13.media_url.as_deref(),
        Some("https://cdn.news.example/ep13.mp3")
    );
    let video = &feed.episodes[3];
    assert_eq!(video.duration_secs, Some(61), "media:content duration");
    assert_eq!(video.mime.as_deref(), Some("video/mp4"));
    // Keys are stable across fetches and distinct.
    let again = parse_feed(ITUNES, &base("https://news.example/feed.xml"), 10).unwrap();
    assert_eq!(feed.episodes[0].key, again.episodes[0].key);
    assert_ne!(feed.episodes[0].key, feed.episodes[1].key);
    // Only the latest N.
    assert_eq!(
        parse_feed(ITUNES, &base("https://news.example/feed.xml"), 2)
            .unwrap()
            .episodes
            .len(),
        2
    );
}

#[test]
fn atom_feed_with_relative_enclosures() {
    let feed = parse_feed(ATOM, &base("https://world.example/podcast/atom.xml"), 3).unwrap();
    assert_eq!(feed.title.as_deref(), Some("World Briefing"));
    assert_eq!(
        feed.artwork_url.as_deref(),
        Some("https://world.example/logo.png")
    );
    assert_eq!(feed.episodes.len(), 2);
    assert_eq!(feed.episodes[0].title, "Evening briefing");
    let morning = &feed.episodes[1];
    assert_eq!(
        morning.media_url.as_deref(),
        Some("https://world.example/podcast/audio/morning.mp3")
    );
    assert_eq!(morning.duration_secs, Some(3725));
    assert_eq!(
        morning.page_url.as_deref(),
        Some("https://world.example/morning")
    );
}

#[test]
fn latin1_feed_is_decoded() {
    let feed = parse_feed(LATIN1, &base("http://radio.example/rss"), 3).unwrap();
    assert_eq!(feed.title.as_deref(), Some("Città Radio"));
    assert_eq!(feed.episodes[0].title, "Notiziario di lunedì");
    assert_eq!(feed.episodes[0].duration_secs, Some(3599));
}

#[test]
fn html_is_not_a_feed() {
    assert!(parse_feed(
        b"<html><head></head></html>",
        &base("https://x.example/"),
        3
    )
    .is_none());
}

// ---- Fixture server ----------------------------------------------------------

#[derive(Default)]
struct Fx {
    port: AtomicUsize,
    feed_hits: AtomicUsize,
    not_modified: AtomicUsize,
    audio_hits: AtomicUsize,
    lookup_hits: AtomicUsize,
}

const AUDIO_LEN: usize = 40_000;

fn audio_bytes() -> Vec<u8> {
    (0..AUDIO_LEN).map(|i| (i % 251) as u8).collect()
}

fn feed_xml(port: usize) -> String {
    format!(
        r#"<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
        <title>Fixture News</title>
        <item><title>Latest</title><guid>g2</guid><pubDate>Wed, 07 Oct 2026 15:00:00 GMT</pubDate>
          <enclosure url="audio.mp3" type="audio/mpeg"/><itunes:duration>2:00</itunes:duration></item>
        <item><title>Redirected</title><guid>g1</guid><pubDate>Wed, 07 Oct 2026 14:00:00 GMT</pubDate>
          <enclosure url="http://127.0.0.1:{port}/redirect.mp3" type="audio/mpeg"/></item>
        </channel></rss>"#
    )
}

async fn feed(
    axum::extract::State(fx): axum::extract::State<Arc<Fx>>,
    headers: HeaderMap,
) -> Response {
    fx.feed_hits.fetch_add(1, Ordering::SeqCst);
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some("\"v1\"")
    {
        fx.not_modified.fetch_add(1, Ordering::SeqCst);
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let port = fx.port.load(Ordering::SeqCst);
    (
        [
            (header::CONTENT_TYPE, "application/rss+xml"),
            (header::ETAG, "\"v1\""),
        ],
        feed_xml(port),
    )
        .into_response()
}

async fn audio(
    axum::extract::State(fx): axum::extract::State<Arc<Fx>>,
    headers: HeaderMap,
) -> Response {
    fx.audio_hits.fetch_add(1, Ordering::SeqCst);
    let data = audio_bytes();
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let spec = range.trim_start_matches("bytes=");
        let (a, b) = spec.split_once('-').unwrap();
        let start: usize = a.parse().unwrap();
        let end: usize = if b.is_empty() {
            AUDIO_LEN - 1
        } else {
            b.parse().unwrap()
        };
        let body = data[start..=end].to_vec();
        return (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, "audio/mpeg".to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{AUDIO_LEN}"),
                ),
            ],
            body,
        )
            .into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "audio/mpeg"),
            (header::ACCEPT_RANGES, "bytes"),
        ],
        data,
    )
        .into_response()
}

async fn redirect_private(axum::extract::State(fx): axum::extract::State<Arc<Fx>>) -> Response {
    let port = fx.port.load(Ordering::SeqCst);
    (
        StatusCode::FOUND,
        [(
            header::LOCATION,
            format!("http://127.0.0.2:{port}/audio.mp3"),
        )],
    )
        .into_response()
}

async fn station(axum::extract::State(fx): axum::extract::State<Arc<Fx>>) -> Response {
    let port = fx.port.load(Ordering::SeqCst);
    (
        [(header::CONTENT_TYPE, "audio/x-scpls")],
        format!("[playlist]\nNumberOfEntries=1\nFile1=http://127.0.0.1:{port}/stream\nTitle1=Fixture FM\n"),
    )
        .into_response()
}

async fn stream() -> Response {
    (
        [
            (header::CONTENT_TYPE, "audio/mpeg"),
            (
                header::HeaderName::from_static("icy-name"),
                "Fixture Icecast",
            ),
        ],
        Body::from(vec![7u8; 5000]),
    )
        .into_response()
}

async fn hls() -> Response {
    (
        [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
        "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.aac\n",
    )
        .into_response()
}

async fn page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        r#"<!doctype html><html><head><title>Fixture radio</title>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>"#,
    )
        .into_response()
}

async fn plain_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html")],
        "<html><head><title>Nothing</title></head><body></body></html>",
    )
        .into_response()
}

/// iTunes lookup stand-in: briefly unavailable on the first call.
async fn lookup(axum::extract::State(fx): axum::extract::State<Arc<Fx>>) -> Response {
    if fx.lookup_hits.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let port = fx.port.load(Ordering::SeqCst);
    axum::Json(json!({
        "resultCount": 1,
        "results": [{ "feedUrl": format!("http://127.0.0.1:{port}/feed.xml") }]
    }))
    .into_response()
}

async fn start_fixture() -> (SocketAddr, Arc<Fx>) {
    let fx = Arc::new(Fx::default());
    let app = Router::new()
        .route("/feed.xml", get(feed))
        .route("/audio.mp3", get(audio))
        .route("/redirect.mp3", get(redirect_private))
        .route("/station.pls", get(station))
        .route("/stream", get(stream))
        .route("/hls.m3u8", get(hls))
        .route("/page.html", get(page))
        .route("/plain.html", get(plain_page))
        .route("/lookup", get(lookup))
        .with_state(fx.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    fx.port.store(addr.port() as usize, Ordering::SeqCst);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, fx)
}

/// A hub that may reach the fixture server on 127.0.0.1 (and nothing else
/// private). yt-dlp stays out of these tests.
fn hub(tag: &str) -> Hub {
    std::env::set_var("ENABLE_YTDLP", "0");
    let hub = Hub::new(tag);
    hub.state.podcasts.set_policy_for_tests(NetPolicy {
        extra_allowed: vec!["127.0.0.1".parse().unwrap()],
        ..Default::default()
    });
    hub
}

/// Same, with the iTunes lookup API answered by the fixture.
fn hub_with_lookup(tag: &str, addr: SocketAddr) -> Hub {
    let hub = hub(tag);
    hub.state.podcasts.set_policy_for_tests(NetPolicy {
        extra_allowed: vec!["127.0.0.1".parse().unwrap()],
        itunes_lookup: Some(format!("http://{addr}/lookup")),
    });
    hub
}

async fn enable(hub: &Hub) {
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/podcasts/admin/settings")
                .json(json!({ "enabled": true }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
}

async fn add_source(hub: &Hub, url: &str) -> serde_json::Value {
    let r = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/sources")
                .json(json!({ "url": url, "episodeCount": 3 }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    r.json()["data"].clone()
}

// ---- HTTP --------------------------------------------------------------------

#[tokio::test]
async fn disabled_module_has_no_endpoints() {
    let hub = hub("pod-off");
    for path in [
        "/api/v1/podcasts",
        "/api/v1/podcasts/sources/1",
        "/api/v1/podcasts/play/1/live",
        "/api/v1/podcasts/art/1/_",
    ] {
        let r = hub.send(req(Method::GET, path).build()).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(r.json()["error"], "podcasts_disabled", "{path}");
    }
    let health = hub.send(req(Method::GET, "/api/v1/health").build()).await;
    let modules = health.json()["modules"].clone();
    assert!(!modules.as_array().unwrap().iter().any(|m| m == "podcasts"));
    // The admin panel can still read and switch it on.
    let admin = hub
        .send(req(Method::GET, "/api/v1/podcasts/admin").build())
        .await;
    assert_eq!(admin.status, StatusCode::OK);
    assert_eq!(admin.json()["data"]["enabled"], false);
    enable(&hub).await;
    let health = hub.send(req(Method::GET, "/api/v1/health").build()).await;
    assert!(health.json()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m == "podcasts"));
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.json()["data"]["sources"], json!([]));
}

#[tokio::test]
async fn admin_writes_are_machine_operations() {
    let hub = hub("pod-perm");
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/podcasts/admin/settings")
                .from(From::Lan)
                .json(json!({ "enabled": true }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json()["error"], "forbidden_remote");
    let r = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/sources")
                .from(From::Tunnel)
                .json(json!({ "url": "https://example.com/feed" }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/test")
                .json(json!({ "url": "https://example.com/feed", "episodeCount": 99 }))
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"], "invalid_episode_count");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn feed_source_ttl_conditional_fetch_and_proxy() {
    let (addr, fx) = start_fixture().await;
    let hub = hub("pod-feed");
    enable(&hub).await;
    let feed_url = format!("http://{addr}/feed.xml");

    let test = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/test")
                .json(json!({ "url": feed_url, "episodeCount": 3 }))
                .build(),
        )
        .await;
    assert_eq!(test.status, StatusCode::OK, "{:?}", test.json());
    assert_eq!(test.json()["data"]["kind"], "rss");
    assert_eq!(test.json()["data"]["title"], "Fixture News");

    let src = add_source(&hub, &feed_url).await;
    let id = src["id"].as_i64().unwrap();
    assert_eq!(src["name"], "Fixture News");
    assert_eq!(src["kind"], "rss");
    assert_eq!(fx.feed_hits.load(Ordering::SeqCst), 2, "test + add");

    // Fresh cache: opening the list does not touch the network.
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(list.status, StatusCode::OK);
    let sources = list.json()["data"]["sources"].clone();
    let eps = sources[0]["episodes"].as_array().unwrap().clone();
    assert_eq!(eps.len(), 2);
    assert_eq!(eps[0]["title"], "Latest");
    assert_eq!(eps[0]["durationSecs"], 120);
    assert!(
        eps[0].get("mediaUrl").is_none(),
        "no upstream URL for clients"
    );
    assert_eq!(fx.feed_hits.load(Ordering::SeqCst), 2);

    // TTL elapsed: one conditional request, answered 304.
    hub.state
        .db
        .with_conn(|c| {
            c.execute(
                "UPDATE podcast_sources SET fetched_at = fetched_at - 7200",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(fx.feed_hits.load(Ordering::SeqCst), 3);
    assert_eq!(fx.not_modified.load(Ordering::SeqCst), 1);
    // "Not modified" is a successful refresh, not a failure.
    assert_eq!(
        list.json()["data"]["sources"][0]["error"],
        serde_json::Value::Null
    );
    assert_eq!(
        list.json()["data"]["sources"][0]["episodes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // ... and fresh again afterwards.
    hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(fx.feed_hits.load(Ordering::SeqCst), 3);

    // Proxy with Range pass-through.
    let key = eps[0]["key"].as_str().unwrap().to_string();
    let play = format!("/api/v1/podcasts/play/{id}/{key}");
    let r = hub
        .send(
            req(Method::GET, &play)
                .header("range", "bytes=100-199")
                .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        r.header("content-range").as_deref(),
        Some(format!("bytes 100-199/{AUDIO_LEN}").as_str())
    );
    assert_eq!(r.body, audio_bytes()[100..200].to_vec());
    assert_eq!(r.header("content-type").as_deref(), Some("audio/mpeg"));
    let full = hub.send(req(Method::GET, &play).build()).await;
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.body.len(), AUDIO_LEN);

    // Only configured episodes: unknown key / source → 404, never a URL.
    let r = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/podcasts/play/{id}/deadbeef00000000"),
            )
            .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json()["error"], "podcast_episode_not_found");
    let r = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/podcasts/play/{}/{key}", id + 100),
            )
            .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let before = fx.audio_hits.load(Ordering::SeqCst);
    let r = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/podcasts/play/{id}/x?url=http://{addr}/audio.mp3"),
            )
            .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(fx.audio_hits.load(Ordering::SeqCst), before);

    // A redirect to a private address is refused on that hop.
    let redirected = eps[1]["key"].as_str().unwrap();
    let r = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/podcasts/play/{id}/{redirected}"),
            )
            .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"], "url_not_allowed");

    // Turning the module off closes everything again.
    hub.send(
        req(Method::PUT, "/api/v1/podcasts/admin/settings")
            .json(json!({ "enabled": false }))
            .build(),
    )
    .await;
    let r = hub.send(req(Method::GET, &play).build()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json()["error"], "podcasts_disabled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_targets_are_refused() {
    let (addr, _fx) = start_fixture().await;
    let hub = hub("pod-ssrf");
    enable(&hub).await;
    for url in [
        format!("http://127.0.0.2:{}/feed.xml", addr.port()),
        "http://192.168.1.1/feed.xml".to_string(),
        "http://localhost/feed.xml".to_string(),
        "file:///etc/passwd".to_string(),
    ] {
        let r = hub
            .send(
                req(Method::POST, "/api/v1/podcasts/admin/test")
                    .json(json!({ "url": url }))
                    .build(),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{url}");
        let code = r.json()["error"].as_str().unwrap().to_string();
        assert!(
            code == "url_not_allowed" || code == "podcast_invalid_url",
            "{url}: {code}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_stream_from_playlist_and_page_discovery() {
    let (addr, _fx) = start_fixture().await;
    let hub = hub("pod-live");
    enable(&hub).await;

    let live = add_source(&hub, &format!("http://{addr}/station.pls")).await;
    assert_eq!(live["kind"], "live");
    assert_eq!(live["name"], "Fixture FM");
    let id = live["id"].as_i64().unwrap();
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    let src = list.json()["data"]["sources"][0].clone();
    assert_eq!(src["live"], true);
    assert_eq!(src["episodes"][0]["key"], "live");
    let r = hub
        .send(req(Method::GET, &format!("/api/v1/podcasts/play/{id}/live")).build())
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("accept-ranges").as_deref(), Some("none"));
    assert_eq!(r.header("content-type").as_deref(), Some("audio/mpeg"));
    assert_eq!(r.body.len(), 5000);

    let page = add_source(&hub, &format!("http://{addr}/page.html")).await;
    assert_eq!(page["kind"], "rss");
    assert_eq!(page["name"], "Fixture News");

    let hls = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/test")
                .json(json!({ "url": format!("http://{addr}/hls.m3u8") }))
                .build(),
        )
        .await;
    assert_eq!(hls.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(hls.json()["error"], "podcast_hls_unsupported");

    let plain = hub
        .send(
            req(Method::POST, "/api/v1/podcasts/admin/test")
                .json(json!({ "url": format!("http://{addr}/plain.html") }))
                .build(),
        )
        .await;
    assert_eq!(plain.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(plain.json()["error"], "podcast_unsupported_url");

    // Order and edits.
    let r = hub
        .send(
            req(Method::PUT, "/api/v1/podcasts/admin/order")
                .json(json!({ "ids": [page["id"], live["id"]] }))
                .build(),
        )
        .await;
    assert_eq!(r.json()["data"]["sources"][0]["id"], page["id"]);
    let r = hub
        .send(
            req(
                Method::PUT,
                &format!("/api/v1/podcasts/admin/sources/{}", page["id"]),
            )
            .json(json!({ "name": "My news", "episodeCount": 1 }))
            .build(),
        )
        .await;
    assert_eq!(r.json()["data"]["name"], "My news");
    assert_eq!(r.json()["data"]["nameCustom"], true);
    assert_eq!(r.json()["data"]["episodeCount"], 1);
    let r = hub
        .send(
            req(
                Method::DELETE,
                &format!("/api/v1/podcasts/admin/sources/{id}"),
            )
            .build(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = hub
        .send(req(Method::GET, &format!("/api/v1/podcasts/play/{id}/live")).build())
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apple_page_resolves_to_its_feed_despite_a_hiccup() {
    let (addr, fx) = start_fixture().await;
    let hub = hub_with_lookup("pod-apple", addr);
    enable(&hub).await;
    // The lookup answers 503 once: retried, and the source is a plain feed
    // (no yt-dlp, which is off in these tests anyway).
    let src = add_source(
        &hub,
        "https://podcasts.apple.com/it/podcast/fixture-news/id4242",
    )
    .await;
    assert_eq!(src["kind"], "rss");
    assert_eq!(src["name"], "Fixture News");
    assert_eq!(
        src["url"],
        "https://podcasts.apple.com/it/podcast/fixture-news/id4242"
    );
    assert_eq!(fx.lookup_hits.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ytdlp_apple_source_moves_to_its_feed_on_refresh() {
    use rekord_core::podcasts::net::Validators;
    use rekord_core::podcasts::store::{self, NewSource};
    use rekord_core::podcasts::SourceKind;
    let (addr, fx) = start_fixture().await;
    let hub = hub_with_lookup("pod-upgrade", addr);
    enable(&hub).await;
    // Saved as a yt-dlp page because the lookup failed when it was added.
    let page = "https://podcasts.apple.com/us/podcast/fixture-news/id4242";
    let id = store::insert(
        &hub.state.db,
        &NewSource {
            url: page,
            name: "Old name",
            name_custom: false,
            kind: SourceKind::Ytdlp,
            feed_url: page,
            episode_count: 3,
            artwork_url: None,
            episodes: &[],
            validators: &Validators::default(),
            fetched_at: None,
        },
    )
    .unwrap();
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(list.status, StatusCode::OK);
    let src = list.json()["data"]["sources"][0].clone();
    assert_eq!(src["kind"], "rss", "{src:?}");
    assert_eq!(src["error"], serde_json::Value::Null);
    assert_eq!(src["name"], "Fixture News");
    assert_eq!(src["episodes"].as_array().unwrap().len(), 2);
    let saved = store::get(&hub.state.db, id).unwrap().unwrap();
    assert_eq!(saved.kind, SourceKind::Rss);
    assert_eq!(
        saved.feed_url,
        format!("http://127.0.0.1:{}/feed.xml", addr.port())
    );
    assert_eq!(saved.url, page, "the admin keeps the address they typed");
    assert_eq!(
        fx.lookup_hits.load(Ordering::SeqCst),
        2,
        "503, then the feed"
    );

    // From now on the feed is asked directly (conditionally), no lookup.
    hub.state
        .db
        .with_conn(|c| {
            c.execute(
                "UPDATE podcast_sources SET fetched_at = fetched_at - 7200",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let list = hub.send(req(Method::GET, "/api/v1/podcasts").build()).await;
    assert_eq!(
        list.json()["data"]["sources"][0]["error"],
        serde_json::Value::Null
    );
    assert_eq!(fx.lookup_hits.load(Ordering::SeqCst), 2);
    assert_eq!(fx.not_modified.load(Ordering::SeqCst), 1);
}
