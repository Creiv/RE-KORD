//! Catalog Web preview: track list of a release page and short audio auditions.
//!
//! The audition is resolved with `yt-dlp -g` and kept server side behind an
//! opaque token, so the browser never sees the (signed, short lived) upstream
//! URL and `<audio src>` stays a plain hub URL.

use crate::config::AppConfig;
use crate::youtube_music::{browse_payload, browse_response_title, walk_collect};
use crate::ytdlp::{
    guess_youtube_url_from_entry_id, javascript_args, pick_flat_entry_url, resolve_ytdlp_path,
    run_json_probe,
};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Long enough to cover an audition that stalls, short enough to stay ephemeral:
/// the browser re-requests ranges with the same token while it plays.
const TOKEN_TTL: Duration = Duration::from_secs(300);
/// Audio first; `best` is the fallback that keeps working when YouTube SABR
/// hides standalone audio URLs (the same reason downloads need it).
const PREVIEW_FORMAT: &str = "bestaudio[acodec^=mp4a]/bestaudio/best";
/// Clients stop at ~30s, so a first chunk is enough to fill the preview.
const DEFAULT_INITIAL_RANGE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWebTrack {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWebTracks {
    pub tracks: Vec<CatalogWebTrack>,
    pub title: Option<String>,
    pub error: Option<String>,
}

/// Accept only public YouTube pages and drop tracking/api params.
pub fn normalize_catalog_web_url(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if s.starts_with("//") {
        s = format!("https:{s}");
    }
    let mut u = url::Url::parse(&s).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if u.path().contains("/youtubei/") {
        return None;
    }
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "music.youtube.com" | "youtube.com" | "m.youtube.com" | "youtu.be"
    ) {
        return None;
    }
    let kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| !matches!(k.as_ref(), "key" | "accountId" | "r"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut q = u.query_pairs_mut();
        q.clear();
        for (k, v) in &kept {
            q.append_pair(k, v);
        }
    }
    if u.query() == Some("") {
        u.set_query(None);
    }
    Some(u.to_string())
}

/// yt-dlp handles `youtube.com` better than `music.youtube.com`.
pub fn url_for_ytdlp_fetch(page_url: &str) -> String {
    let Some(norm) = normalize_catalog_web_url(page_url) else {
        return String::new();
    };
    let Ok(u) = url::Url::parse(&norm) else {
        return norm;
    };
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host != "music.youtube.com" {
        return norm;
    }
    if let Some(list) = query_value(&u, "list") {
        return format!("https://www.youtube.com/playlist?list={list}");
    }
    if let Some(v) = query_value(&u, "v") {
        return format!("https://www.youtube.com/watch?v={v}");
    }
    norm
}

fn query_value(u: &url::Url, key: &str) -> Option<String> {
    u.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.trim().is_empty())
}

pub fn is_youtube_playlist_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| query_value(&u, "list"))
        .is_some()
}

fn is_watch_single_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host == "youtu.be" {
        return u
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .is_some_and(|s| !s.is_empty());
    }
    if !host.contains("youtube") {
        return false;
    }
    query_value(&u, "list").is_none() && query_value(&u, "v").is_some()
}

fn video_id_from_watch_url(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host == "youtu.be" {
        let id = u.path().trim_start_matches('/').split('/').next()?.trim();
        return (!id.is_empty()).then(|| id.to_string());
    }
    query_value(&u, "v")
}

fn playlist_id_from_page_url(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|u| query_value(&u, "list"))
}

fn watch_url_for_video(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

fn track_from_responsive_renderer(renderer: &Value) -> Option<CatalogWebTrack> {
    let title = crate::youtube_music::extract_runs_text(
        renderer
            .pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text")
            .unwrap_or(&Value::Null),
    )
    .trim()
    .to_string();
    let endpoint = renderer
        .pointer(
            "/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint",
        )
        .or_else(|| renderer.get("navigationEndpoint"))?;
    let video_id = endpoint
        .pointer("/watchEndpoint/videoId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if title.is_empty() {
        return None;
    }
    Some(CatalogWebTrack {
        id: video_id.to_string(),
        title,
        url: watch_url_for_video(video_id),
    })
}

fn track_from_playlist_video_renderer(renderer: &Value) -> Option<CatalogWebTrack> {
    let title = crate::youtube_music::extract_runs_text(&renderer["title"])
        .trim()
        .to_string();
    let video_id = renderer
        .get("videoId")
        .or_else(|| renderer.pointer("/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if title.is_empty() {
        return None;
    }
    Some(CatalogWebTrack {
        id: video_id.to_string(),
        title,
        url: watch_url_for_video(video_id),
    })
}

fn tracks_from_browse_json(json: &Value) -> Vec<CatalogWebTrack> {
    let mut responsive = Vec::new();
    let mut playlist_videos = Vec::new();
    walk_collect(json, "musicResponsiveListItemRenderer", &mut responsive);
    walk_collect(json, "playlistVideoRenderer", &mut playlist_videos);
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    for r in responsive {
        if let Some(t) = track_from_responsive_renderer(r) {
            if seen.insert(t.id.clone()) {
                tracks.push(t);
            }
        }
    }
    for r in playlist_videos {
        if let Some(t) = track_from_playlist_video_renderer(r) {
            if seen.insert(t.id.clone()) {
                tracks.push(t);
            }
        }
    }
    tracks
}

/// `VL`-prefixed and bare ids are both valid browse targets, depending on the list.
fn playlist_browse_ids(playlist_id: &str) -> Vec<String> {
    let pid = playlist_id.trim();
    if pid.is_empty() {
        return vec![];
    }
    let mut out = vec![pid.to_string()];
    if let Some(bare) = pid.strip_prefix("VL") {
        if !bare.is_empty() {
            out.push(bare.to_string());
        }
    } else {
        out.push(format!("VL{pid}"));
    }
    out.dedup();
    out
}

async fn tracks_via_innertube_playlist(
    playlist_id: &str,
) -> Option<(Vec<CatalogWebTrack>, String)> {
    for browse_id in playlist_browse_ids(playlist_id) {
        if let Ok(json) = browse_payload(&browse_id).await {
            let tracks = tracks_from_browse_json(&json);
            if !tracks.is_empty() {
                return Some((tracks, browse_response_title(&json)));
            }
        }
    }
    None
}

async fn tracks_via_ytdlp(cfg: &AppConfig, page_url: &str) -> Result<Vec<CatalogWebTrack>> {
    let data = run_json_probe(cfg, page_url, 25_000).await?;
    let entries = if data.get("_type").and_then(|v| v.as_str()) == Some("video") {
        vec![data.clone()]
    } else {
        data.get("entries")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    for e in entries {
        let id = e
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let title = e
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let mut url = pick_flat_entry_url(&e);
        if !url.starts_with("http") {
            url = guess_youtube_url_from_entry_id(&id);
        }
        let Some(url) = normalize_catalog_web_url(&url) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        tracks.push(CatalogWebTrack {
            title: if title.is_empty() { id.clone() } else { title },
            id,
            url,
        });
    }
    Ok(tracks)
}

/// Track list of a release page: Innertube first, yt-dlp flat playlist as fallback.
pub async fn release_tracks(cfg: &AppConfig, page_url: &str) -> CatalogWebTracks {
    let Some(url) = normalize_catalog_web_url(page_url) else {
        return CatalogWebTracks {
            error: Some("Invalid URL".into()),
            ..Default::default()
        };
    };

    if is_watch_single_url(&url) {
        if let Some(id) = video_id_from_watch_url(&url) {
            return CatalogWebTracks {
                tracks: vec![CatalogWebTrack {
                    id,
                    title: "Track".into(),
                    url,
                }],
                ..Default::default()
            };
        }
    }

    let browse_id = crate::youtube_music::browse_id_from_music_browse_page_url(&url);
    if let Some(browse_id) = browse_id.filter(|b| b.starts_with("MPREb_")) {
        match browse_payload(&browse_id).await {
            Ok(json) => {
                let tracks = tracks_from_browse_json(&json);
                if !tracks.is_empty() {
                    return CatalogWebTracks {
                        title: Some(browse_response_title(&json)).filter(|t| !t.is_empty()),
                        tracks,
                        error: None,
                    };
                }
            }
            Err(e) if !crate::ytdlp::ytdlp_enabled() => {
                return CatalogWebTracks {
                    error: Some(e.to_string()),
                    ..Default::default()
                };
            }
            Err(_) => {}
        }
    }

    if let Some(playlist_id) = playlist_id_from_page_url(&url) {
        if let Some((tracks, title)) = tracks_via_innertube_playlist(&playlist_id).await {
            return CatalogWebTracks {
                tracks,
                title: Some(title).filter(|t| !t.is_empty()),
                error: None,
            };
        }
    }

    if !crate::ytdlp::ytdlp_enabled() {
        return CatalogWebTracks {
            error: Some("Track list requires yt-dlp (ENABLE_YTDLP)".into()),
            ..Default::default()
        };
    }

    let fetch_url = {
        let coerced = url_for_ytdlp_fetch(&url);
        if coerced.is_empty() {
            url.clone()
        } else {
            coerced
        }
    };
    match tracks_via_ytdlp(cfg, &fetch_url).await {
        Ok(tracks) => CatalogWebTracks {
            error: tracks.is_empty().then(|| "No tracks found".to_string()),
            tracks,
            title: None,
        },
        Err(e) => CatalogWebTracks {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

struct TokenEntry {
    stream_url: String,
    expires: Instant,
}

fn token_cache() -> &'static Mutex<HashMap<String, TokenEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, TokenEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_tokens(map: &mut HashMap<String, TokenEntry>) {
    let now = Instant::now();
    map.retain(|_, v| v.expires > now);
}

/// Resolve the audio stream for a watch URL and hand back an opaque token.
pub async fn create_preview_token(cfg: &AppConfig, watch_url: &str) -> Result<String> {
    let url = normalize_catalog_web_url(watch_url).context("Invalid URL")?;
    let fetch_url = {
        let coerced = url_for_ytdlp_fetch(&url);
        if coerced.is_empty() {
            url
        } else {
            coerced
        }
    };
    let program = resolve_ytdlp_path(cfg);
    let mut args = vec![
        "-g".to_string(),
        "-f".to_string(),
        PREVIEW_FORMAT.to_string(),
    ];
    if is_youtube_playlist_url(&fetch_url) {
        args.push("--playlist-items".into());
        args.push("1".into());
    } else {
        args.push("--no-playlist".into());
    }
    args.push("--no-warnings".into());
    args.extend(javascript_args());
    if let Some(cookies) = cfg.youtube_cookies_for_ytdlp() {
        args.push("--cookies".into());
        args.push(cookies.to_string_lossy().into_owned());
    }
    args.push(fetch_url);

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", program.display()))?;
    let output = tokio::time::timeout(Duration::from_millis(30_000), child.wait_with_output())
        .await
        .context("yt-dlp preview timeout")?
        .context("yt-dlp preview")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stream_url = stdout
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http://") || l.starts_with("https://"));
    let Some(stream_url) = stream_url else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        if detail.is_empty() {
            bail!("Could not resolve preview stream (yt-dlp)");
        }
        bail!("Could not resolve preview stream: {detail}");
    };

    let token = uuid::Uuid::new_v4().to_string();
    let mut map = token_cache().lock().unwrap();
    prune_tokens(&mut map);
    map.insert(
        token.clone(),
        TokenEntry {
            stream_url: stream_url.to_string(),
            expires: Instant::now() + TOKEN_TTL,
        },
    );
    Ok(token)
}

pub fn preview_stream_url(token: &str) -> Option<String> {
    let mut map = token_cache().lock().unwrap();
    prune_tokens(&mut map);
    map.get(token.trim()).map(|e| e.stream_url.clone())
}

/// Range requested when the client does not ask for one; keeps the audition short.
pub fn initial_range_bytes() -> u64 {
    std::env::var("REKORD_PREVIEW_INITIAL_RANGE_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_INITIAL_RANGE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_drops_api_params() {
        let out = normalize_catalog_web_url(
            "https://music.youtube.com/watch?v=abc12345678&key=secret&accountId=1",
        )
        .unwrap();
        assert!(out.contains("v=abc12345678"));
        assert!(!out.contains("key="));
        assert!(!out.contains("accountId="));
    }

    #[test]
    fn rejects_foreign_hosts_and_innertube() {
        assert!(normalize_catalog_web_url("https://example.com/watch?v=x").is_none());
        assert!(
            normalize_catalog_web_url("https://music.youtube.com/youtubei/v1/browse").is_none()
        );
        assert!(normalize_catalog_web_url("").is_none());
    }

    #[test]
    fn coerces_music_urls_for_ytdlp() {
        assert_eq!(
            url_for_ytdlp_fetch("https://music.youtube.com/playlist?list=OLAK5uy_abc"),
            "https://www.youtube.com/playlist?list=OLAK5uy_abc"
        );
        assert_eq!(
            url_for_ytdlp_fetch("https://music.youtube.com/watch?v=abc12345678"),
            "https://www.youtube.com/watch?v=abc12345678"
        );
        assert_eq!(
            url_for_ytdlp_fetch("https://www.youtube.com/watch?v=abc12345678"),
            "https://www.youtube.com/watch?v=abc12345678"
        );
    }

    #[test]
    fn detects_single_watch_urls() {
        assert!(is_watch_single_url(
            "https://www.youtube.com/watch?v=abc12345678"
        ));
        assert!(!is_watch_single_url(
            "https://www.youtube.com/watch?v=abc12345678&list=OLAK5uy_x"
        ));
        assert!(is_watch_single_url("https://youtu.be/abc12345678"));
    }

    #[test]
    fn parses_tracks_from_playlist_renderers() {
        let json = serde_json::json!({
            "contents": [
                { "playlistVideoRenderer": {
                    "videoId": "vid1",
                    "title": { "runs": [{ "text": "First" }] }
                } },
                { "playlistVideoRenderer": {
                    "videoId": "vid1",
                    "title": { "runs": [{ "text": "Duplicate" }] }
                } },
                { "musicResponsiveListItemRenderer": {
                    "flexColumns": [
                        { "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Second" }] }
                        } }
                    ],
                    "navigationEndpoint": { "watchEndpoint": { "videoId": "vid2" } }
                } }
            ]
        });
        // Responsive rows come before playlist rows, and duplicate ids are dropped.
        let tracks = tracks_from_browse_json(&json);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Second");
        assert_eq!(tracks[1].title, "First");
        assert_eq!(tracks[1].url, "https://www.youtube.com/watch?v=vid1");
    }

    #[test]
    fn token_round_trip_and_expiry() {
        let mut map = token_cache().lock().unwrap();
        map.insert(
            "live".into(),
            TokenEntry {
                stream_url: "https://example.invalid/a".into(),
                expires: Instant::now() + TOKEN_TTL,
            },
        );
        map.insert(
            "stale".into(),
            TokenEntry {
                stream_url: "https://example.invalid/b".into(),
                expires: Instant::now() - Duration::from_secs(1),
            },
        );
        drop(map);
        assert_eq!(
            preview_stream_url("live").as_deref(),
            Some("https://example.invalid/a")
        );
        assert!(preview_stream_url("stale").is_none());
    }
}
