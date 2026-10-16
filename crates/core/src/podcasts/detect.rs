//! What a URL is (feed, page with a feed, play.rtl.it archive, yt-dlp page,
//! live stream, playlist) and how a source's latest episodes are fetched.

use super::discover::{
    apple_feed_url, apple_lookup_url, discover_feed_links, is_hls, known_patterns, parse_playlist,
    playlist_title, KnownPattern,
};
use super::feed::{looks_like_feed, parse_feed};
use super::net::{
    fetch_document, fetch_json, is_audio_type, is_playlist_type, parse_public_url, Fetched,
    NetPolicy, Validators,
};
use super::store::{Source, SourceKind};
use super::xml::decode_text;
use super::{rtl, ytdlp_src, Episode, PodcastError};
use crate::config::AppConfig;

/// Feeds above this are refused (the biggest real feeds are a few MB).
pub const MAX_FEED_BYTES: usize = 8 * 1024 * 1024;
/// Pages are read only for their `<head>` links: 2 MB is plenty.
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const ACCEPT_FEED: &str = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.7, */*;q=0.5";
/// Feed links / playlist entries tried at most.
const MAX_CANDIDATES: usize = 3;

#[derive(Debug, Clone)]
pub struct Detected {
    pub kind: SourceKind,
    pub feed_url: String,
    pub title: Option<String>,
    pub artwork_url: Option<String>,
    pub episodes: Vec<Episode>,
    pub validators: Validators,
}

fn rtl_feed_url(broadcaster: &str, slug: &str) -> String {
    format!("rtl:{broadcaster}/{slug}")
}

fn parse_rtl_feed_url(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("rtl:")?;
    let (b, slug) = rest.split_once('/')?;
    Some((b.to_string(), slug.to_string()))
}

fn path_ext(url: &url::Url) -> String {
    url.path()
        .rsplit('/')
        .next()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn host_title(url: &url::Url) -> Option<String> {
    url.host_str()
        .map(|h| h.trim_start_matches("www.").to_string())
}

/// Detect what `raw_url` is and preview its latest `limit` episodes.
pub async fn detect(
    cfg: &AppConfig,
    policy: &NetPolicy,
    raw_url: &str,
    limit: u32,
) -> Result<Detected, PodcastError> {
    let url = parse_public_url(raw_url)?;
    // Show pages of well-known sites (Apple Podcasts, Spreaker) name their
    // feed in the address: no need to read the page (nor its host).
    let known = known_patterns(&url, None);
    if !known.is_empty() {
        if let Some(d) = known_feed(&url, policy, limit, 2).await {
            return Ok(d);
        }
    }
    // Refuse private targets before anything else (yt-dlp included).
    super::net::resolve_allowed(&url, policy).await?;

    if let Some((b, slug)) = rtl::match_url(&url) {
        let (title, episodes) = rtl_latest(&b, &slug, limit, policy).await?;
        return Ok(Detected {
            kind: SourceKind::Rtl,
            feed_url: rtl_feed_url(&b, &slug),
            artwork_url: episodes.iter().find_map(|e| e.artwork_url.clone()),
            title,
            episodes,
            validators: Validators::default(),
        });
    }

    let fetched = fetch_document(&url, policy, ACCEPT_FEED, MAX_FEED_BYTES, None).await;
    let (final_url, content_type, body, validators, icy_name) = match fetched {
        Ok(Fetched::Body {
            final_url,
            content_type,
            body,
            validators,
            icy_name,
        }) => (final_url, content_type, body, validators, icy_name),
        Ok(Fetched::NotModified) => return Err(PodcastError::Unsupported),
        // A page that refuses us may still be readable by yt-dlp.
        Err(PodcastError::Http(code)) if code == 403 || code == 404 || code == 406 => {
            // yt-dlp failing too: the page's own answer is the clearer error.
            return via_ytdlp(cfg, &url, limit)
                .await
                .map_err(|_| PodcastError::Http(code));
        }
        Err(e) => return Err(e),
    };

    // Live audio stream.
    if is_audio_type(&content_type) {
        return Ok(live(
            final_url.as_str(),
            icy_name.or_else(|| host_title(&final_url)),
        ));
    }

    let text_head = String::from_utf8_lossy(&body[..body.len().min(2048)]).to_string();
    let ext = path_ext(&final_url);
    let playlist_like = is_playlist_type(&content_type)
        || matches!(ext.as_str(), "m3u" | "m3u8" | "pls")
        || text_head.trim_start().starts_with("#EXTM3U")
        || text_head
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("[playlist]");
    if playlist_like && !looks_like_feed(&body) {
        let text = decode_text(&body);
        if is_hls(&text) {
            return Err(PodcastError::Hls);
        }
        let name = playlist_title(&text);
        for entry in parse_playlist(&text, &final_url)
            .into_iter()
            .take(MAX_CANDIDATES)
        {
            let Ok(u) = parse_public_url(&entry) else {
                continue;
            };
            match fetch_document(&u, policy, "*/*", 64 * 1024, None).await {
                Ok(Fetched::Body {
                    final_url,
                    content_type,
                    body,
                    icy_name,
                    ..
                }) => {
                    if is_audio_type(&content_type) {
                        let title = name.or(icy_name).or_else(|| host_title(&final_url));
                        return Ok(live(final_url.as_str(), title));
                    }
                    if is_hls(&decode_text(&body)) {
                        return Err(PodcastError::Hls);
                    }
                }
                Ok(Fetched::NotModified) => {}
                Err(PodcastError::UrlNotAllowed) => return Err(PodcastError::UrlNotAllowed),
                Err(_) => {}
            }
        }
        return Err(PodcastError::Unsupported);
    }

    if looks_like_feed(&body) {
        return feed_detected(&body, &final_url, limit, validators);
    }

    let is_html = content_type.contains("html") || text_head.to_ascii_lowercase().contains("<html");
    if is_html {
        let html = decode_text(&body[..body.len().min(MAX_PAGE_BYTES)]);
        let (links, page_title) = discover_feed_links(&html, &final_url);
        let mut candidates: Vec<String> = links.into_iter().take(MAX_CANDIDATES).collect();
        for pattern in known_patterns(&final_url, Some(&html)) {
            if known.contains(&pattern) {
                continue; // tried above
            }
            match pattern {
                KnownPattern::Feed(u) => candidates.push(u),
                KnownPattern::AppleLookup(id) => {
                    if let Some(u) = apple_lookup(&id, policy, 1).await {
                        candidates.insert(0, u);
                    }
                }
            }
        }
        for candidate in candidates {
            let Ok(u) = parse_public_url(&candidate) else {
                continue;
            };
            if let Ok(Fetched::Body {
                final_url,
                body,
                validators,
                ..
            }) = fetch_document(&u, policy, ACCEPT_FEED, MAX_FEED_BYTES, None).await
            {
                if looks_like_feed(&body) {
                    if let Ok(mut d) = feed_detected(&body, &final_url, limit, validators) {
                        if d.title.is_none() {
                            d.title = page_title.clone();
                        }
                        return Ok(d);
                    }
                }
            }
        }
        let mut d = via_ytdlp(cfg, &final_url, limit).await?;
        if d.title.is_none() {
            d.title = page_title;
        }
        return Ok(d);
    }

    via_ytdlp(cfg, &final_url, limit).await
}

/// The feed of a well-known show page, found from its address alone, or
/// `None` (failures are logged, the caller falls back to other ways).
/// `lookup_attempts`: how many times the iTunes lookup is asked.
async fn known_feed(
    page: &url::Url,
    policy: &NetPolicy,
    limit: u32,
    lookup_attempts: u32,
) -> Option<Detected> {
    for pattern in known_patterns(page, None) {
        let candidate = match pattern {
            KnownPattern::Feed(u) => u,
            KnownPattern::AppleLookup(id) => match apple_lookup(&id, policy, lookup_attempts).await
            {
                Some(u) => u,
                None => continue,
            },
        };
        let fetched = match parse_public_url(&candidate) {
            Ok(u) => fetch_document(&u, policy, ACCEPT_FEED, MAX_FEED_BYTES, None).await,
            Err(e) => Err(e),
        };
        let result = match fetched {
            Ok(Fetched::Body {
                final_url,
                body,
                validators,
                ..
            }) => feed_detected(&body, &final_url, limit, validators),
            Ok(Fetched::NotModified) => Err(PodcastError::Unsupported),
            Err(e) => Err(e),
        };
        match result {
            Ok(d) => return Some(d),
            Err(e) => tracing::info!(
                page = page.host_str().unwrap_or(""),
                code = e.code(),
                error = %e,
                "known podcast feed unreachable"
            ),
        }
    }
    None
}

/// Feed URL of Apple Podcasts show `id` from the iTunes lookup API.
async fn apple_lookup(id: &str, policy: &NetPolicy, attempts: u32) -> Option<String> {
    let api = url::Url::parse(&apple_lookup_url(id, policy.itunes_lookup.as_deref())).ok()?;
    for attempt in 1..=attempts.max(1) {
        if attempt > 1 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        match fetch_json(&api, policy, 512 * 1024).await {
            Ok(json) => match apple_feed_url(&json) {
                Some(u) => return Some(u),
                None => tracing::info!(id, attempt, "itunes lookup: no feed for this show"),
            },
            Err(e) => {
                tracing::info!(id, attempt, code = e.code(), error = %e, "itunes lookup failed")
            }
        }
    }
    None
}

/// RTL JSON API, else the programme's RSS feed.
async fn rtl_latest(
    broadcaster: &str,
    slug: &str,
    limit: u32,
    policy: &NetPolicy,
) -> Result<(Option<String>, Vec<Episode>), PodcastError> {
    match rtl::fetch_latest(broadcaster, slug, limit, policy).await {
        Ok(found) => Ok(found),
        Err(api_err) => {
            tracing::info!(slug, error = %api_err, "rtl api failed, trying the rss feed");
            let url = parse_public_url(&rtl::rss_fallback_url(slug))?;
            match fetch_document(&url, policy, ACCEPT_FEED, MAX_FEED_BYTES, None).await {
                Ok(Fetched::Body {
                    final_url, body, ..
                }) => {
                    let d = feed_detected(&body, &final_url, limit, Validators::default())?;
                    Ok((d.title, d.episodes))
                }
                _ => Err(api_err),
            }
        }
    }
}

fn live(stream_url: &str, title: Option<String>) -> Detected {
    Detected {
        kind: SourceKind::Live,
        feed_url: stream_url.to_string(),
        title,
        artwork_url: None,
        episodes: Vec::new(),
        validators: Validators::default(),
    }
}

fn feed_detected(
    body: &[u8],
    base: &url::Url,
    limit: u32,
    validators: Validators,
) -> Result<Detected, PodcastError> {
    let feed = parse_feed(body, base, limit as usize)
        .ok_or_else(|| PodcastError::Parse("not a feed".into()))?;
    if feed.episodes.is_empty() {
        return Err(PodcastError::NoEpisodes);
    }
    Ok(Detected {
        kind: SourceKind::Rss,
        feed_url: base.to_string(),
        title: feed.title,
        artwork_url: feed.artwork_url,
        episodes: feed.episodes,
        validators,
    })
}

async fn via_ytdlp(cfg: &AppConfig, url: &url::Url, limit: u32) -> Result<Detected, PodcastError> {
    if !crate::ytdlp::ytdlp_enabled() {
        return Err(PodcastError::Unsupported);
    }
    let (title, episodes) = ytdlp_src::list(cfg, url.as_str(), limit).await?;
    Ok(Detected {
        kind: SourceKind::Ytdlp,
        feed_url: url.to_string(),
        artwork_url: episodes.iter().find_map(|e| e.artwork_url.clone()),
        title,
        episodes,
        validators: Validators::default(),
    })
}

pub enum Refreshed {
    NotModified,
    Fresh {
        title: Option<String>,
        artwork_url: Option<String>,
        episodes: Vec<Episode>,
        validators: Validators,
        /// The source is a plain feed from now on, at this address.
        retarget: Option<String>,
    },
}

/// Latest episodes of a configured source (conditional for feeds).
pub async fn fetch_episodes(
    cfg: &AppConfig,
    policy: &NetPolicy,
    src: &Source,
) -> Result<Refreshed, PodcastError> {
    let limit = src.episode_count;
    match src.kind {
        SourceKind::Live => Ok(Refreshed::NotModified),
        SourceKind::Rss => {
            let url = parse_public_url(&src.feed_url)?;
            let validators = Validators {
                etag: src.etag.clone(),
                last_modified: src.last_modified.clone(),
            };
            let have_cache = !src.episodes.is_empty();
            match fetch_document(
                &url,
                policy,
                ACCEPT_FEED,
                MAX_FEED_BYTES,
                have_cache.then_some(&validators),
            )
            .await?
            {
                Fetched::NotModified => Ok(Refreshed::NotModified),
                Fetched::Body {
                    final_url,
                    body,
                    validators,
                    ..
                } => {
                    let d = feed_detected(&body, &final_url, limit, validators)?;
                    Ok(Refreshed::Fresh {
                        title: d.title,
                        artwork_url: d.artwork_url,
                        episodes: d.episodes,
                        validators: d.validators,
                        retarget: None,
                    })
                }
            }
        }
        SourceKind::Rtl => {
            let (b, slug) = parse_rtl_feed_url(&src.feed_url).ok_or(PodcastError::InvalidUrl)?;
            let (title, episodes) = rtl_latest(&b, &slug, limit, policy).await?;
            Ok(Refreshed::Fresh {
                artwork_url: episodes.iter().find_map(|e| e.artwork_url.clone()),
                title,
                episodes,
                validators: Validators::default(),
                retarget: None,
            })
        }
        SourceKind::Ytdlp => {
            let url = parse_public_url(&src.feed_url)?;
            // A show page whose feed could not be found when it was added
            // (the iTunes lookup failed, say): try again, and stay on the
            // feed once it answers — faster and sturdier than yt-dlp.
            let known_page = [Some(url.clone()), parse_public_url(&src.url).ok()]
                .into_iter()
                .flatten()
                .find(|u| !known_patterns(u, None).is_empty());
            if let Some(page) = known_page {
                if let Some(d) = known_feed(&page, policy, limit, 1).await {
                    tracing::info!(source = src.id, "yt-dlp podcast source moved to its feed");
                    return Ok(Refreshed::Fresh {
                        title: d.title,
                        artwork_url: d.artwork_url,
                        episodes: d.episodes,
                        validators: d.validators,
                        retarget: Some(d.feed_url),
                    });
                }
            }
            super::net::resolve_allowed(&url, policy).await?;
            let (title, episodes) = ytdlp_src::list(cfg, url.as_str(), limit).await?;
            Ok(Refreshed::Fresh {
                artwork_url: episodes.iter().find_map(|e| e.artwork_url.clone()),
                title,
                episodes,
                validators: Validators::default(),
                retarget: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtl_feed_urls_round_trip() {
        let s = rtl_feed_url("1", "giornale-orario");
        assert_eq!(
            parse_rtl_feed_url(&s),
            Some(("1".into(), "giornale-orario".into()))
        );
        assert_eq!(parse_rtl_feed_url("https://x"), None);
    }
}
