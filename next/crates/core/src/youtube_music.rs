//! YouTube Music Innertube helpers (explore search, new releases, browse).

use crate::config::AppConfig;
use crate::ytdlp::{
    coerce_ytdlp_url, guess_youtube_url_from_entry_id, parse_ytdlp_json, pick_flat_entry_url,
    playlist_track_count, run_json_probe,
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

fn innertube_context() -> Value {
    json!({
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": client_version(),
            "hl": "it",
            "gl": "IT",
        }
    })
}

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("RE-KORD/5.1 (+https://github.com/rekord; studio)")
        .timeout(std::time::Duration::from_secs(25))
        .build()?)
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

fn extract_runs_text(node: &Value) -> String {
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

fn walk_collect<'a>(node: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
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
    let watch = url_from_watch(ep);
    let playlist = url_from_playlist(ep);
    let url = if !watch.is_empty() {
        watch.clone()
    } else {
        playlist.clone()
    };
    if url.is_empty() {
        return None;
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
    let q = query.trim();
    if q.len() < 2 {
        bail!("query too short");
    }
    let body = json!({
        "context": innertube_context(),
        "query": q,
    });
    let data = innertube_post(YTM_SEARCH_URL, body).await?;
    let mut list_items = Vec::new();
    let mut two_row = Vec::new();
    walk_collect(&data, "musicResponsiveListItemRenderer", &mut list_items);
    walk_collect(&data, "musicTwoRowItemRenderer", &mut two_row);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in list_items {
        if let Some(item) = parse_responsive_list_item(r) {
            if seen.insert(item.url.clone()) {
                out.push(item);
            }
        }
    }
    for r in two_row {
        if let Some(item) = parse_two_row_item(r) {
            if seen.insert(item.url.clone()) {
                out.push(item);
            }
        }
    }
    // Prefer artist → album → song order like legacy.
    out.sort_by_key(|r| match r.kind.as_str() {
        "artist" => 0,
        "album" => 1,
        _ => 2,
    });
    out.truncate(48);
    Ok(out)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    if let Some(items) = renderer.pointer("/menu/menuRenderer/items").and_then(|v| v.as_array())
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

async fn browse_new_releases(browse_id: &str) -> Result<Vec<CatalogWebItem>> {
    let body = json!({
        "context": innertube_context(),
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

pub async fn catalog_web_discover(local_album_keys: &HashSet<String>) -> CatalogWebDiscover {
    let albums_res = browse_new_releases(NEW_RELEASES_ALBUMS).await;
    let singles_res = browse_new_releases(NEW_RELEASES_SINGLES).await;
    let mut error = None;
    let mut albums = albums_res.unwrap_or_else(|e| {
        error = Some(e.to_string());
        vec![]
    });
    let mut songs = singles_res.unwrap_or_else(|e| {
        if error.is_none() {
            error = Some(e.to_string());
        }
        vec![]
    });
    let filter = |items: &mut Vec<CatalogWebItem>| {
        items.retain(|it| {
            let key = format!(
                "{} / {}",
                it.subtitle.split('•').next().unwrap_or("").trim(),
                it.title
            )
            .to_lowercase();
            !local_album_keys.iter().any(|k| {
                let kl = k.to_lowercase();
                kl.contains(&it.title.to_lowercase()) || key.contains(&kl)
            })
        });
        // Sample up to 36
        if items.len() > 36 {
            items.truncate(36);
        }
    };
    filter(&mut albums);
    filter(&mut songs);
    CatalogWebDiscover {
        artists: vec![],
        albums,
        songs,
        error,
    }
}

/// Flat-count helper used by API.
pub async fn flat_playlist_count(cfg: &AppConfig, url: &str) -> Result<u64> {
    let data = run_json_probe(cfg, url, 30_000).await?;
    Ok(playlist_track_count(&data).unwrap_or(0))
}

/// Silence unused import warning if parse_ytdlp_json unused in some builds.
#[allow(dead_code)]
fn _keep(v: &str) -> Result<Value> {
    parse_ytdlp_json(v)
}
