//! YouTube Music Innertube helpers (explore search, new releases, browse).

use crate::config::AppConfig;
use crate::ytdlp::{
    coerce_ytdlp_url, guess_youtube_url_from_entry_id, pick_flat_entry_url, playlist_track_count,
    run_json_probe,
};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const YTM_KEY: &str = "AIzaSyC9XL3QWnjsQplBUbSJY1cffBoVwD0aN1U";
const YTM_SEARCH_URL: &str = "https://music.youtube.com/youtubei/v1/search";
const YTM_BROWSE_URL: &str = "https://music.youtube.com/youtubei/v1/browse";
const NEW_RELEASES_ALBUMS: &str = "FEmusic_new_releases_albums";
const NEW_RELEASES_SINGLES: &str = "FEmusic_new_releases_singles";

fn client_version() -> String {
    std::env::var("REKORD_YTM_INNERTUBE_CLIENT_VERSION")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "1.20241127.01.00".into())
}

/// Innertube language / region (`hl` / `gl`), from the request locale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YtmLocale {
    pub hl: String,
    pub gl: String,
}

impl Default for YtmLocale {
    /// Legacy default (the app's primary audience).
    fn default() -> Self {
        Self {
            hl: "it".into(),
            gl: "IT".into(),
        }
    }
}

impl YtmLocale {
    /// From explicit `hl` / `gl` (or `locale=it-IT`), then `Accept-Language`,
    /// then the default. Only `[A-Za-z-]` tags are accepted.
    pub fn from_request(hl: Option<&str>, gl: Option<&str>, accept_language: Option<&str>) -> Self {
        fn clean(s: &str) -> Option<String> {
            let t = s.trim().replace('_', "-");
            (!t.is_empty()
                && t.len() <= 16
                && t.chars().all(|c| c.is_ascii_alphabetic() || c == '-'))
            .then_some(t)
        }
        let tag = hl.and_then(clean).or_else(|| {
            accept_language
                .and_then(|h| h.split(',').next())
                .map(|first| first.split(';').next().unwrap_or("").to_string())
                .and_then(|t| clean(&t))
        });
        let Some(tag) = tag else {
            return Self::default();
        };
        let mut parts = tag.split('-');
        let lang = parts.next().unwrap_or("it").to_ascii_lowercase();
        let region_from_tag = parts.find(|p| p.len() == 2).map(|r| r.to_ascii_uppercase());
        let region = gl
            .and_then(clean)
            .filter(|g| g.len() == 2)
            .map(|g| g.to_ascii_uppercase())
            .or(region_from_tag)
            .unwrap_or_else(|| match lang.as_str() {
                "en" => "US".into(),
                "it" => "IT".into(),
                other if other.len() == 2 => other.to_ascii_uppercase(),
                _ => "US".into(),
            });
        Self {
            hl: lang,
            gl: region,
        }
    }
}

fn innertube_context_for(locale: &YtmLocale) -> Value {
    json!({
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": client_version(),
            "hl": locale.hl,
            "gl": locale.gl,
        }
    })
}

fn innertube_context() -> Value {
    innertube_context_for(&YtmLocale::default())
}

fn http_client() -> Result<reqwest::Client> {
    Ok(crate::net::client(
        "studio discover",
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(25),
    ))
}

async fn innertube_post(url: &str, body: Value) -> Result<Value> {
    let client = http_client()?;
    let res = client
        .post(format!("{url}?key={YTM_KEY}"))
        .header("Content-Type", "application/json")
        .header("X-YouTube-Client-Name", "67")
        .header("X-YouTube-Client-Version", client_version())
        .header("Origin", "https://music.youtube.com")
        .json(&body)
        .send()
        .await
        .context("innertube request")?;
    if !res.status().is_success() {
        bail!("innertube HTTP {}", res.status());
    }
    Ok(res.json().await?)
}

/// Innertube browse payload for a browseId (album `MPREb_…`, playlist `VL…`, feeds).
pub(crate) async fn browse_payload(browse_id: &str) -> Result<Value> {
    let body = json!({
        "context": innertube_context(),
        "browseId": browse_id,
    });
    innertube_post(YTM_BROWSE_URL, body).await
}

pub(crate) fn browse_response_title(json: &Value) -> String {
    extract_runs_text(
        json.pointer("/header/musicHeaderRenderer/title")
            .unwrap_or(&Value::Null),
    )
    .trim()
    .to_string()
}

pub(crate) fn extract_runs_text(node: &Value) -> String {
    if let Some(arr) = node.get("runs").and_then(|v| v.as_array()) {
        return arr
            .iter()
            .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("");
    }
    node.get("simpleText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn walk_collect<'a>(node: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            if let Some(v) = map.get(key) {
                out.push(v);
            }
            for v in map.values() {
                walk_collect(v, key, out);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                walk_collect(v, key, out);
            }
        }
        _ => {}
    }
}

fn pick_best_thumb(thumbnails: &Value) -> Option<String> {
    let arr = thumbnails.as_array()?;
    let mut best: Option<(&Value, i64)> = None;
    for t in arr {
        let w = t.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
        if best.map(|(_, bw)| w > bw).unwrap_or(true) {
            best = Some((t, w));
        }
    }
    best.and_then(|(t, _)| {
        t.get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

fn thumbnail_from_renderer(renderer: &Value) -> Option<String> {
    let paths = [
        &renderer["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"],
        &renderer["thumbnailRenderer"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"],
        &renderer["musicThumbnailRenderer"]["thumbnail"]["thumbnails"],
    ];
    for p in paths {
        if let Some(u) = pick_best_thumb(p) {
            return Some(u);
        }
    }
    None
}

fn url_from_watch(ep: &Value) -> String {
    ep.get("watchEndpoint")
        .and_then(|w| w.get("videoId"))
        .and_then(|v| v.as_str())
        .map(|id| format!("https://music.youtube.com/watch?v={id}"))
        .unwrap_or_default()
}

fn url_from_playlist(ep: &Value) -> String {
    ep.pointer("/watchPlaylistEndpoint/playlistId")
        .and_then(|v| v.as_str())
        .map(|id| format!("https://music.youtube.com/playlist?list={id}"))
        .unwrap_or_default()
}

fn url_from_browse(ep: &Value) -> String {
    let Some(id) = ep
        .pointer("/browseEndpoint/browseId")
        .and_then(|v| v.as_str())
        .map(str::trim)
    else {
        return String::new();
    };
    if id.starts_with("UC") {
        return format!("https://music.youtube.com/channel/{id}");
    }
    if id.starts_with("MPREb_") {
        return format!("https://music.youtube.com/browse/{id}");
    }
    String::new()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreResult {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
}

/// `MUSIC_PAGE_TYPE_…` of a browse endpoint (artist, album, podcast, …).
fn browse_page_type(ep: &Value) -> &str {
    ep.pointer("/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

/// Podcast shows and episodes are not music to download into the library.
fn is_podcast_endpoint(ep: &Value) -> bool {
    browse_page_type(ep).starts_with("MUSIC_PAGE_TYPE_PODCAST")
        || ep
            .pointer("/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType")
            .and_then(|v| v.as_str())
            .is_some_and(|t| t.contains("PODCAST"))
}

/// An artist row (no play button, a browse endpoint to the artist page).
fn artist_result(
    title: String,
    subtitle: String,
    ep: &Value,
    renderer: &Value,
) -> Option<ExploreResult> {
    if browse_page_type(ep) != "MUSIC_PAGE_TYPE_ARTIST" {
        return None;
    }
    let url = url_from_browse(ep);
    if !url.contains("/channel/") {
        return None;
    }
    let id = ep
        .pointer("/browseEndpoint/browseId")?
        .as_str()?
        .to_string();
    Some(ExploreResult {
        id,
        kind: "artist".into(),
        title,
        subtitle,
        url,
        thumbnail_url: thumbnail_from_renderer(renderer),
    })
}

/// The "top result" card: kept when it is an artist (songs and albums shown
/// there are repeated in the shelves below).
fn parse_card_shelf(renderer: &Value) -> Option<ExploreResult> {
    let title = extract_runs_text(&renderer["title"]).trim().to_string();
    if title.is_empty() {
        return None;
    }
    let subtitle = extract_runs_text(&renderer["subtitle"]).trim().to_string();
    let ep = &renderer["title"]["runs"][0]["navigationEndpoint"];
    artist_result(title, subtitle, ep, renderer)
}

fn parse_responsive_list_item(renderer: &Value) -> Option<ExploreResult> {
    let title = extract_runs_text(
        &renderer["flexColumns"][0]["musicResponsiveListItemFlexColumnRenderer"]["text"],
    )
    .trim()
    .to_string();
    if title.is_empty() {
        return None;
    }
    let subtitle = extract_runs_text(
        &renderer["flexColumns"][1]["musicResponsiveListItemFlexColumnRenderer"]["text"],
    )
    .trim()
    .to_string();
    let ep = if !renderer["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]
        ["musicPlayButtonRenderer"]["playNavigationEndpoint"]
        .is_null()
    {
        &renderer["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]
            ["musicPlayButtonRenderer"]["playNavigationEndpoint"]
    } else {
        &renderer["navigationEndpoint"]
    };
    if is_podcast_endpoint(ep) || is_podcast_endpoint(&renderer["navigationEndpoint"]) {
        return None;
    }
    let watch = url_from_watch(ep);
    let playlist = url_from_playlist(ep);
    let url = if !watch.is_empty() {
        watch.clone()
    } else {
        playlist.clone()
    };
    if url.is_empty() {
        return artist_result(title, subtitle, &renderer["navigationEndpoint"], renderer);
    }
    let id = ep
        .pointer("/watchEndpoint/videoId")
        .or_else(|| ep.pointer("/watchPlaylistEndpoint/playlistId"))
        .and_then(|v| v.as_str())
        .unwrap_or(&url)
        .to_string();
    let kind = if !playlist.is_empty() && watch.is_empty() {
        "album"
    } else {
        "song"
    };
    Some(ExploreResult {
        id,
        kind: kind.into(),
        title,
        subtitle,
        url,
        thumbnail_url: thumbnail_from_renderer(renderer),
    })
}

fn parse_two_row_item(renderer: &Value) -> Option<ExploreResult> {
    let title = extract_runs_text(&renderer["title"]).trim().to_string();
    if title.is_empty() {
        return None;
    }
    let subtitle = extract_runs_text(&renderer["subtitle"]).trim().to_string();
    let ep = &renderer["navigationEndpoint"];
    if is_podcast_endpoint(ep) {
        return None;
    }
    let playlist = url_from_playlist(ep);
    let browse = url_from_browse(ep);
    let watch = url_from_watch(ep);
    let url = [playlist.as_str(), browse.as_str(), watch.as_str()]
        .into_iter()
        .find(|u| !u.is_empty())
        .unwrap_or("")
        .to_string();
    if url.is_empty() {
        return None;
    }
    let kind = if browse.contains("/channel/") {
        "artist"
    } else if !playlist.is_empty() || browse.contains("/browse/") {
        "album"
    } else {
        "song"
    };
    let id = ep
        .pointer("/browseEndpoint/browseId")
        .or_else(|| ep.pointer("/watchPlaylistEndpoint/playlistId"))
        .or_else(|| ep.pointer("/watchEndpoint/videoId"))
        .and_then(|v| v.as_str())
        .unwrap_or(&url)
        .to_string();
    Some(ExploreResult {
        id,
        kind: kind.into(),
        title,
        subtitle,
        url,
        thumbnail_url: thumbnail_from_renderer(renderer),
    })
}

pub async fn explore_search(query: &str) -> Result<Vec<ExploreResult>> {
    explore_search_with(query, &YtmLocale::default()).await
}

pub async fn explore_search_with(query: &str, locale: &YtmLocale) -> Result<Vec<ExploreResult>> {
    let q = query.trim();
    if q.len() < 2 {
        bail!("query too short");
    }
    let body = json!({
        "context": innertube_context_for(locale),
        "query": q,
    });
    let data = innertube_post(YTM_SEARCH_URL, body).await?;
    Ok(parse_explore_results(&data))
}

/// Search results from an innertube search payload: artists first, then
/// albums / playlists, then songs; podcasts and user profiles are left out.
fn parse_explore_results(data: &Value) -> Vec<ExploreResult> {
    let mut cards = Vec::new();
    let mut list_items = Vec::new();
    let mut two_row = Vec::new();
    walk_collect(data, "musicCardShelfRenderer", &mut cards);
    walk_collect(data, "musicResponsiveListItemRenderer", &mut list_items);
    walk_collect(data, "musicTwoRowItemRenderer", &mut two_row);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let parsed = cards
        .into_iter()
        .filter_map(parse_card_shelf)
        .chain(
            list_items
                .into_iter()
                .filter_map(parse_responsive_list_item),
        )
        .chain(two_row.into_iter().filter_map(parse_two_row_item));
    for item in parsed {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }
    // Prefer artist → album → song order like legacy (stable: the top
    // result stays first among artists).
    out.sort_by_key(|r| match r.kind.as_str() {
        "artist" => 0,
        "album" => 1,
        _ => 2,
    });
    out.truncate(48);
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasesList {
    pub list_title: String,
    pub uploader: String,
    pub channel_url: String,
    pub entries: Vec<ReleaseEntry>,
}

pub fn is_youtube_releases_tab_url(value: &str) -> bool {
    let Ok(u) = url::Url::parse(value.trim()) else {
        return false;
    };
    let h = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    (h.ends_with("youtube.com") || h.ends_with("music.youtube.com"))
        && u.path().contains("/releases")
}

pub fn is_youtube_music_browse_url(value: &str) -> bool {
    let Ok(u) = url::Url::parse(value.trim()) else {
        return false;
    };
    let h = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    h.ends_with("music.youtube.com")
        && (u.path().contains("/browse") || u.path().contains("/channel/"))
}

/// BrowseId from `music.youtube.com/browse/…` or `/channel/…`.
pub fn browse_id_from_music_browse_page_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    let h = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if h != "music.youtube.com" {
        return None;
    }
    let mut segs = u.path_segments()?;
    let kind = segs.next()?;
    if kind != "browse" && kind != "channel" {
        return None;
    }
    let id = segs.next()?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn album_playlist_id_from_two_row(renderer: &Value) -> Option<String> {
    let items = renderer
        .pointer("/menu/menuRenderer/items")
        .and_then(|v| v.as_array())?;
    for it in items {
        let pid = it
            .pointer(
                "/menuNavigationItemRenderer/navigationEndpoint/watchPlaylistEndpoint/playlistId",
            )
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(pid) = pid {
            if pid.starts_with("OLAK5uy_") {
                return Some(pid.to_string());
            }
        }
    }
    for it in items {
        let pid = it
            .pointer(
                "/menuServiceItemRenderer/serviceEndpoint/queueAddEndpoint/queueTarget/playlistId",
            )
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(pid) = pid {
            if pid.starts_with("OLAK5uy_") {
                return Some(pid.to_string());
            }
        }
    }
    None
}

fn fallback_browse_url_from_two_row(renderer: &Value) -> (String, String) {
    let bid = renderer
        .pointer("/navigationEndpoint/browseEndpoint/browseId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if bid.starts_with("MPREb_") {
        return (
            bid.clone(),
            format!("https://music.youtube.com/browse/{bid}"),
        );
    }
    (String::new(), String::new())
}

fn build_entries_from_browse_json(json: &Value) -> Vec<ReleaseEntry> {
    let mut buckets = Vec::new();
    walk_collect(json, "musicTwoRowItemRenderer", &mut buckets);
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for r in buckets {
        let title = extract_runs_text(&r["title"]).trim().to_string();
        if title.is_empty() {
            continue;
        }
        let (id, url) = if let Some(playlist_id) = album_playlist_id_from_two_row(r) {
            (
                playlist_id.clone(),
                format!("https://music.youtube.com/playlist?list={playlist_id}"),
            )
        } else {
            fallback_browse_url_from_two_row(r)
        };
        if id.is_empty() || url.is_empty() {
            continue;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        entries.push(ReleaseEntry {
            id,
            title,
            url,
            track_count: None,
        });
    }
    entries
}

/// Album list from a music.youtube.com/browse/… page via Innertube (like legacy).
pub async fn releases_list_via_innertube_browse(page_url: &str) -> Result<ReleasesList> {
    let browse_id = browse_id_from_music_browse_page_url(page_url)
        .ok_or_else(|| anyhow::anyhow!("Not a YouTube Music browse or channel URL"))?;
    let data = browse_payload(&browse_id).await?;
    let list_title = browse_response_title(&data);
    let entries = build_entries_from_browse_json(&data);
    if entries.is_empty() {
        bail!("No releases found on this YouTube Music browse page (Innertube)");
    }
    Ok(ReleasesList {
        list_title: list_title.clone(),
        uploader: list_title,
        channel_url: String::new(),
        entries,
    })
}

/// Prefers Innertube for YTM browse pages; yt-dlp for /releases tabs.
pub async fn releases_list_for_url(cfg: &AppConfig, url: &str) -> Result<ReleasesList> {
    if is_youtube_music_browse_url(url) {
        return releases_list_via_innertube_browse(url).await;
    }
    releases_list_via_ytdlp(cfg, url).await
}

pub async fn releases_list_via_ytdlp(cfg: &AppConfig, url: &str) -> Result<ReleasesList> {
    let data = run_json_probe(cfg, url, 45_000).await?;
    let raw = data
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::new();
    for e in raw {
        let id = e
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let title = e
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let mut norm = pick_flat_entry_url(&e);
        if norm.is_empty() || !norm.starts_with("http") {
            norm = guess_youtube_url_from_entry_id(&id);
        }
        if !id.is_empty() && !title.is_empty() && norm.starts_with("http") {
            entries.push(ReleaseEntry {
                id,
                title,
                url: coerce_ytdlp_url(&norm),
                track_count: None,
            });
        }
    }
    Ok(ReleasesList {
        list_title: data
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        uploader: data
            .get("uploader")
            .or_else(|| data.get("channel"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        channel_url: data
            .get("channel_url")
            .or_else(|| data.get("uploader_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        entries,
    })
}

pub async fn enrich_track_count(cfg: &AppConfig, url: &str) -> Option<u64> {
    let data = run_json_probe(cfg, url, 18_000).await.ok()?;
    playlist_track_count(&data)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWebItem {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWebDiscover {
    pub artists: Vec<CatalogWebItem>,
    pub albums: Vec<CatalogWebItem>,
    pub songs: Vec<CatalogWebItem>,
    /// Code of the first feed error (`upstream_rejected`, …), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Every feed error, structured.
    pub errors: Vec<DiscoverError>,
    /// Singles came from the albums feed because the singles feed failed.
    pub singles_recovered: bool,
}

fn playlist_id_from_endpoint(ep: &Value) -> String {
    ep.pointer("/watchPlaylistEndpoint/playlistId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn resolve_album_url(renderer: &Value) -> String {
    let ep = &renderer["navigationEndpoint"];
    let pid = playlist_id_from_endpoint(ep);
    if !pid.is_empty() {
        return format!("https://music.youtube.com/playlist?list={pid}");
    }
    // menu items
    if let Some(items) = renderer
        .pointer("/menu/menuRenderer/items")
        .and_then(|v| v.as_array())
    {
        for it in items {
            let ep = it
                .pointer("/menuNavigationItemRenderer/navigationEndpoint")
                .or_else(|| it.pointer("/menuServiceItemRenderer/navigationEndpoint"));
            if let Some(ep) = ep {
                let pid = playlist_id_from_endpoint(ep);
                if !pid.is_empty() {
                    return format!("https://music.youtube.com/playlist?list={pid}");
                }
                let browse = url_from_browse(ep);
                if !browse.is_empty() {
                    return browse;
                }
            }
        }
    }
    url_from_browse(ep)
}

async fn browse_new_releases(browse_id: &str, locale: &YtmLocale) -> Result<Vec<CatalogWebItem>> {
    let body = json!({
        "context": innertube_context_for(locale),
        "browseId": browse_id,
    });
    let data = innertube_post(YTM_BROWSE_URL, body).await?;
    let mut two_row = Vec::new();
    walk_collect(&data, "musicTwoRowItemRenderer", &mut two_row);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in two_row {
        let title = extract_runs_text(&r["title"]).trim().to_string();
        if title.is_empty() {
            continue;
        }
        let subtitle = extract_runs_text(&r["subtitle"]).trim().to_string();
        let url = resolve_album_url(r);
        if url.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let id = r
            .pointer("/navigationEndpoint/browseEndpoint/browseId")
            .or_else(|| r.pointer("/navigationEndpoint/watchPlaylistEndpoint/playlistId"))
            .and_then(|v| v.as_str())
            .unwrap_or(&url)
            .to_string();
        out.push(CatalogWebItem {
            id,
            title,
            subtitle,
            url,
            thumbnail_url: thumbnail_from_renderer(r),
        });
    }
    Ok(out)
}

/// Release type and artist of a new-releases subtitle («Single • Artist»,
/// «EP • …», «Album • …»; parity legacy `parseDiscoverSubtitleLine`).
pub fn parse_discover_subtitle(subtitle: &str) -> (Option<String>, String) {
    let raw = subtitle.trim();
    for sep in ['•', '·', '|', '–', '—', '-'] {
        if let Some((head, tail)) = raw.split_once(sep) {
            let head = head.trim();
            let known = ["album", "ep", "single", "singolo", "video"];
            if known.contains(&head.to_lowercase().as_str()) {
                return (Some(head.to_string()), tail.trim().to_string());
            }
        }
    }
    (None, raw.to_string())
}

fn is_watch_single_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or("");
    if !host.contains("youtube.com") && !host.contains("youtu.be") {
        return false;
    }
    if u.query_pairs().any(|(k, _)| k == "list") {
        return false;
    }
    u.query_pairs().any(|(k, _)| k == "v") || host.contains("youtu.be")
}

/// `song` or `album` (parity legacy `classifyDiscoverKind`).
pub fn classify_discover_kind(item: &CatalogWebItem, from_singles_feed: bool) -> &'static str {
    let (release_type, _) = parse_discover_subtitle(&item.subtitle);
    let t = release_type.unwrap_or_default().to_lowercase();
    if t == "single" || t == "singolo" || t == "video" || from_singles_feed {
        return "song";
    }
    if is_watch_single_url(&item.url) {
        return "song";
    }
    "album"
}

/// Accent / case / punctuation-insensitive label (legacy `normalizeDiscoverLabel`).
pub fn normalize_discover_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars() {
        let base = fold_accent(c);
        for b in base.to_lowercase() {
            if b.is_alphanumeric() {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.push(b);
            } else {
                space = true;
            }
        }
    }
    out
}

fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' => 'A',
        'è' | 'é' | 'ê' | 'ë' | 'ē' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' => 'E',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' => 'I',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' => 'O',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' => 'U',
        'ñ' => 'n',
        'Ñ' => 'N',
        'ç' => 'c',
        'Ç' => 'C',
        'ý' | 'ÿ' => 'y',
        'Ý' => 'Y',
        other => other,
    }
}

/// Library albums as normalized `artist|album` keys.
pub fn library_album_keys<'a>(
    albums: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    for (artist, album) in albums {
        let a = normalize_discover_label(artist);
        let n = normalize_discover_label(album);
        if !a.is_empty() && !n.is_empty() {
            out.insert(format!("{a}|{n}"));
        }
    }
    out
}

/// Exact normalized artist + title match against the library.
pub fn is_in_library(item: &CatalogWebItem, library: &HashSet<String>) -> bool {
    let (_, artist) = parse_discover_subtitle(&item.subtitle);
    // "Artist1 & Artist2 • 2026": keep only the artist part.
    let artist = artist.split('•').next().unwrap_or("").trim().to_string();
    let a = normalize_discover_label(&artist);
    let t = normalize_discover_label(&item.title);
    !a.is_empty() && !t.is_empty() && library.contains(&format!("{a}|{t}"))
}

/// Random sample without replacement (partial Fisher–Yates).
fn random_subset<T>(mut items: Vec<T>, count: usize) -> Vec<T> {
    let n = count.min(items.len());
    let mut seed = uuid::Uuid::new_v4().as_u128() as u64 | 1;
    let mut next = || {
        // xorshift64*
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        seed.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };
    for i in 0..n {
        let span = (items.len() - i) as u64;
        let j = i + (next() % span) as usize;
        items.swap(i, j);
    }
    items.truncate(n);
    items
}

/// Items shown per section.
pub const DISCOVER_SAMPLE: usize = 36;

/// Structured upstream error of the discover feed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverError {
    /// `albums` / `singles`.
    pub feed: &'static str,
    pub code: &'static str,
    pub message: String,
}

fn discover_error(feed: &'static str, e: &anyhow::Error) -> DiscoverError {
    let m = e.to_string();
    let code = if m.contains("HTTP 4") {
        "upstream_rejected"
    } else if m.contains("HTTP 5") {
        "upstream_unavailable"
    } else if m.to_lowercase().contains("timed out") {
        "upstream_timeout"
    } else {
        "upstream_failed"
    };
    DiscoverError {
        feed,
        code,
        message: m,
    }
}

/// New releases (albums + singles) not already in the library, sampled.
/// When the singles feed fails, singles / EP-less "Single" items are
/// recovered from the albums feed (legacy `classifyDiscoverKind`).
pub async fn catalog_web_discover(
    library: &HashSet<String>,
    locale: &YtmLocale,
) -> CatalogWebDiscover {
    let (albums_res, singles_res) = tokio::join!(
        browse_new_releases(NEW_RELEASES_ALBUMS, locale),
        browse_new_releases(NEW_RELEASES_SINGLES, locale)
    );
    let mut errors = Vec::new();
    let album_feed = albums_res.unwrap_or_else(|e| {
        errors.push(discover_error("albums", &e));
        vec![]
    });
    let singles_ok = singles_res.is_ok();
    let singles_feed = singles_res.unwrap_or_else(|e| {
        errors.push(discover_error("singles", &e));
        vec![]
    });
    let mut albums = Vec::new();
    let mut songs = Vec::new();
    for it in album_feed {
        if classify_discover_kind(&it, false) == "song" {
            songs.push(it);
        } else {
            albums.push(it);
        }
    }
    let mut seen: HashSet<String> = songs.iter().map(|s| s.url.clone()).collect();
    for it in singles_feed {
        if seen.insert(it.url.clone()) {
            songs.push(it);
        }
    }
    albums.retain(|it| !is_in_library(it, library));
    songs.retain(|it| !is_in_library(it, library));
    let albums = random_subset(albums, DISCOVER_SAMPLE);
    let songs = random_subset(songs, DISCOVER_SAMPLE);
    // A failed singles feed recovered from the albums feed is not an error
    // for the page; it stays listed in `errors`.
    let blocking_error = errors
        .iter()
        .find(|e| e.feed != "singles" || songs.is_empty())
        .map(|e| e.code.to_string());
    CatalogWebDiscover {
        artists: vec![],
        albums,
        songs,
        error: blocking_error,
        errors,
        singles_recovered: !singles_ok,
    }
}

/// Flat-count helper used by API.
/// `None` when yt-dlp answered but the count is unknown.
pub async fn flat_playlist_count(cfg: &AppConfig, url: &str) -> Result<Option<u64>> {
    let data = run_json_probe(cfg, url, 30_000).await?;
    Ok(playlist_track_count(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, subtitle: &str, url: &str) -> CatalogWebItem {
        CatalogWebItem {
            id: title.into(),
            title: title.into(),
            subtitle: subtitle.into(),
            url: url.into(),
            thumbnail_url: None,
        }
    }

    #[test]
    fn discover_classifies_singles_out_of_albums_feed() {
        let single = item(
            "Song",
            "Single • Artist",
            "https://music.youtube.com/playlist?list=OLAK1",
        );
        let album = item(
            "Record",
            "Album • Artist",
            "https://music.youtube.com/playlist?list=OLAK2",
        );
        let ep = item(
            "Five",
            "EP • Artist",
            "https://music.youtube.com/playlist?list=OLAK3",
        );
        let watch = item(
            "Clip",
            "Artist",
            "https://www.youtube.com/watch?v=abc12345678",
        );
        assert_eq!(classify_discover_kind(&single, false), "song");
        assert_eq!(classify_discover_kind(&album, false), "album");
        assert_eq!(classify_discover_kind(&ep, false), "album");
        assert_eq!(classify_discover_kind(&watch, false), "song");
        assert_eq!(classify_discover_kind(&album, true), "song");
    }

    #[test]
    fn library_match_is_exact_normalized() {
        let lib = library_album_keys([("Beyoncé", "Cowboy Carter"), ("Eagles", "Desperado")]);
        assert!(is_in_library(
            &item("COWBOY  CARTER", "Album • Beyonce", ""),
            &lib
        ));
        assert!(is_in_library(&item("Desperado", "Eagles", ""), &lib));
        // Substrings no longer match.
        assert!(!is_in_library(
            &item("Desperado (Live)", "Album • Eagles", ""),
            &lib
        ));
        assert!(!is_in_library(&item("Carter", "Album • Beyoncé", ""), &lib));
        assert!(!is_in_library(
            &item("Desperado", "Album • Other", ""),
            &lib
        ));
    }

    #[test]
    fn random_subset_samples_without_replacement() {
        let v: Vec<u32> = (0..100).collect();
        let s = random_subset(v.clone(), 36);
        assert_eq!(s.len(), 36);
        let uniq: HashSet<_> = s.iter().collect();
        assert_eq!(uniq.len(), 36);
        assert_eq!(random_subset(vec![1, 2], 36).len(), 2);
    }

    #[test]
    fn locale_from_request() {
        assert_eq!(
            YtmLocale::from_request(Some("en-GB"), None, None),
            YtmLocale {
                hl: "en".into(),
                gl: "GB".into()
            }
        );
        assert_eq!(
            YtmLocale::from_request(None, None, Some("de-DE,de;q=0.9,en;q=0.8")),
            YtmLocale {
                hl: "de".into(),
                gl: "DE".into()
            }
        );
        assert_eq!(
            YtmLocale::from_request(Some("en"), Some("ca"), None),
            YtmLocale {
                hl: "en".into(),
                gl: "CA".into()
            }
        );
        assert_eq!(
            YtmLocale::from_request(Some("<script>"), None, None),
            YtmLocale::default()
        );
    }

    #[test]
    fn browse_id_from_skrillex_mpad_url() {
        let id = browse_id_from_music_browse_page_url(
            "https://music.youtube.com/browse/MPADUCibXKvuw5PoJVmyZJ4qhDIw",
        );
        assert_eq!(id.as_deref(), Some("MPADUCibXKvuw5PoJVmyZJ4qhDIw"));
    }

    #[test]
    fn music_browse_and_releases_url_checks() {
        assert!(is_youtube_music_browse_url(
            "https://music.youtube.com/browse/MPADUCibXKvuw5PoJVmyZJ4qhDIw"
        ));
        assert!(is_youtube_releases_tab_url(
            "https://www.youtube.com/channel/UCibXKvuw5PoJVmyZJ4qhDIw/releases"
        ));
        assert!(!is_youtube_music_browse_url(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ));
    }

    fn browse(id: &str, page_type: &str) -> Value {
        json!({ "browseEndpoint": { "browseId": id, "browseEndpointContextSupportedConfigs": {
            "browseEndpointContextMusicConfig": { "pageType": page_type } } } })
    }

    fn row(title: &str, subtitle: &str, nav: Option<Value>, play: Option<Value>) -> Value {
        let mut r = json!({ "flexColumns": [
            { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": title }] } } },
            { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": subtitle }] } } }
        ] });
        if let Some(nav) = nav {
            r["navigationEndpoint"] = nav;
        }
        if let Some(play) = play {
            r["overlay"] = json!({ "musicItemThumbnailOverlayRenderer": { "content": {
                "musicPlayButtonRenderer": { "playNavigationEndpoint": play } } } });
        }
        json!({ "musicResponsiveListItemRenderer": r })
    }

    fn watch(id: &str, video_type: &str) -> Value {
        json!({ "watchEndpoint": { "videoId": id, "watchEndpointMusicSupportedConfigs": {
            "watchEndpointMusicConfig": { "musicVideoType": video_type } } } })
    }

    #[test]
    fn explore_search_keeps_artists_and_drops_podcasts() {
        let data = json!({ "contents": [
            { "musicCardShelfRenderer": {
                "title": { "runs": [{ "text": "Black Flag",
                    "navigationEndpoint": browse("UCtop", "MUSIC_PAGE_TYPE_ARTIST") }] },
                "subtitle": { "runs": [{ "text": "Artist • 61K subscribers" }] } } },
            { "musicShelfRenderer": { "contents": [
                row("Revenge", "Song • 1:00", None, Some(watch("vid00000001", "MUSIC_VIDEO_TYPE_ATV"))),
                row("Damaged", "Album • Black Flag • 1981",
                    Some(browse("MPREb_x", "MUSIC_PAGE_TYPE_ALBUM")),
                    Some(json!({ "watchPlaylistEndpoint": { "playlistId": "OLAK5uy_x" } }))),
                row("Episode", "Episode • Show", None,
                    Some(watch("vid00000002", "MUSIC_VIDEO_TYPE_PODCAST_EPISODE"))),
                row("Show", "Podcast • Host",
                    Some(browse("MPSPPLx", "MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE")),
                    Some(json!({ "watchPlaylistEndpoint": { "playlistId": "PLshow" } }))),
                row("Black Flag Jack", "Artist", Some(browse("UCjack", "MUSIC_PAGE_TYPE_ARTIST")), None),
                row("blackflag", "Profile • @blackflag", Some(browse("UCuser", "MUSIC_PAGE_TYPE_USER_CHANNEL")), None),
                // Same artist as the top card: listed once.
                row("Black Flag", "Artist", Some(browse("UCtop", "MUSIC_PAGE_TYPE_ARTIST")), None)
            ] } }
        ] });
        let got: Vec<(String, String, String)> = parse_explore_results(&data)
            .into_iter()
            .map(|r| (r.kind, r.title, r.url))
            .collect();
        let exp = [
            (
                "artist",
                "Black Flag",
                "https://music.youtube.com/channel/UCtop",
            ),
            (
                "artist",
                "Black Flag Jack",
                "https://music.youtube.com/channel/UCjack",
            ),
            (
                "album",
                "Damaged",
                "https://music.youtube.com/playlist?list=OLAK5uy_x",
            ),
            (
                "song",
                "Revenge",
                "https://music.youtube.com/watch?v=vid00000001",
            ),
        ]
        .map(|(k, t, u)| (k.to_string(), t.to_string(), u.to_string()));
        assert_eq!(got, exp);
    }
}
