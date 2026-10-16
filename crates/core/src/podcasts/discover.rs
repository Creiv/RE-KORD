//! Finding a feed behind a web page, and reading `.m3u` / `.pls` playlists.

use super::feed::resolve;
use super::xml::{Token, Tokenizer};

/// Feed links a page advertises (`<link rel="alternate" type="application/rss+xml">`),
/// in page order, plus the page title. Only the `<head>` is read.
pub fn discover_feed_links(html: &str, base: &url::Url) -> (Vec<String>, Option<String>) {
    let mut links = Vec::new();
    let mut title: Option<String> = None;
    let mut in_title = false;
    let mut og_title: Option<String> = None;
    for tok in Tokenizer::new(html) {
        match tok {
            Token::Start { name, attrs, .. } => {
                let get = |k: &str| {
                    attrs
                        .iter()
                        .find(|(a, _)| a == k)
                        .map(|(_, v)| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                };
                match name.as_str() {
                    "link" => {
                        let rel = get("rel").unwrap_or_default().to_ascii_lowercase();
                        let ty = get("type").unwrap_or_default().to_ascii_lowercase();
                        let feed_type = ty.contains("rss")
                            || ty.contains("atom")
                            || ty == "application/xml"
                            || ty == "text/xml";
                        if rel.split_whitespace().any(|r| r == "alternate") && feed_type {
                            if let Some(u) = get("href").and_then(|h| resolve(base, &h)) {
                                if !links.contains(&u) {
                                    links.push(u);
                                }
                            }
                        }
                    }
                    "meta" if get("property").as_deref() == Some("og:title") => {
                        og_title = get("content");
                    }
                    "title" => in_title = true,
                    "body" => break,
                    _ => {}
                }
            }
            Token::End { name } => {
                if name == "title" {
                    in_title = false;
                }
                if name == "head" {
                    break;
                }
            }
            Token::Text(t) => {
                if in_title && title.is_none() {
                    let s = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !s.is_empty() {
                        title = Some(s);
                    }
                }
            }
        }
    }
    // Comment feeds ("Commenti", "Comments Feed") are never the podcast.
    links.sort_by_key(|u| u.to_ascii_lowercase().contains("comment"));
    (links, og_title.or(title))
}

/// Feeds well-known podcast sites keep at a predictable address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownPattern {
    /// Apple Podcasts show page (its numeric id): the iTunes lookup API
    /// names the feed (see [`apple_lookup_url`]).
    AppleLookup(String),
    /// Plain feed URL derived from the page URL.
    Feed(String),
}

pub fn known_patterns(page: &url::Url, html: Option<&str>) -> Vec<KnownPattern> {
    let host = page
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let path = page.path();
    let mut out = Vec::new();
    if host == "podcasts.apple.com" || host == "itunes.apple.com" {
        if let Some(id) = path
            .split('/')
            .rev()
            .find_map(|seg| seg.strip_prefix("id"))
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        {
            out.push(KnownPattern::AppleLookup(id.to_string()));
        }
    }
    if host == "spreaker.com" {
        // /show/<slug-or-id> or /podcast/<slug>--<id>
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let id = match segs.as_slice() {
            ["show", id, ..] => Some(id.to_string()),
            ["podcast", slug, ..] => slug.rsplit("--").next().map(str::to_string),
            _ => None,
        };
        if let Some(id) = id {
            out.push(KnownPattern::Feed(format!(
                "https://www.spreaker.com/show/{id}/episodes/feed"
            )));
        }
    }
    if let Some(html) = html {
        // WordPress sites (most Italian radio sites) serve /feed/ under any archive.
        if html.contains("/wp-content/") || html.contains("/wp-includes/") {
            let mut u = page.clone();
            u.set_query(None);
            u.set_fragment(None);
            let p = u.path().trim_end_matches('/').to_string();
            if !p.ends_with("/feed") {
                u.set_path(&format!("{p}/feed/"));
                out.push(KnownPattern::Feed(u.to_string()));
            }
        }
    }
    out
}

/// iTunes lookup API address for show `id` (`base` replaces Apple's in tests).
pub fn apple_lookup_url(id: &str, base: Option<&str>) -> String {
    let base = base.unwrap_or("https://itunes.apple.com/lookup");
    format!("{base}?id={id}&entity=podcast")
}

/// Feed URL out of the iTunes lookup answer.
pub fn apple_feed_url(json: &serde_json::Value) -> Option<String> {
    json.get("results")?
        .as_array()?
        .iter()
        .find_map(|r| r.get("feedUrl").and_then(|v| v.as_str()))
        .map(str::to_string)
}

/// Stream URLs of an `.m3u` / `.m3u8` (non-HLS) or `.pls` playlist, in order.
pub fn parse_playlist(body: &str, base: &url::Url) -> Vec<String> {
    let text = body.trim_start_matches('\u{feff}');
    let is_pls = text
        .lines()
        .take(5)
        .any(|l| l.trim().eq_ignore_ascii_case("[playlist]"));
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let candidate = if is_pls {
            match line.split_once('=') {
                Some((k, v)) if k.trim().to_ascii_lowercase().starts_with("file") => v.trim(),
                _ => continue,
            }
        } else {
            line
        };
        if let Some(u) = resolve(base, candidate) {
            if !out.contains(&u) {
                out.push(u);
            }
        }
    }
    out
}

/// An HLS playlist (segments or variants), as opposed to a plain list of streams.
pub fn is_hls(body: &str) -> bool {
    body.contains("#EXT-X-TARGETDURATION")
        || body.contains("#EXT-X-STREAM-INF")
        || body.contains("#EXT-X-MEDIA-SEQUENCE")
}

/// Station name a playlist may carry (`#EXTINF:-1,Name` / `Title1=Name`).
pub fn playlist_title(body: &str) -> Option<String> {
    for line in body.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("#EXTINF:") {
            if let Some((_, name)) = rest.split_once(',') {
                let n = name.trim();
                if !n.is_empty() {
                    return Some(n.to_string());
                }
            }
        }
        if let Some((k, v)) = l.split_once('=') {
            if k.trim().eq_ignore_ascii_case("title1") && !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> url::Url {
        url::Url::parse("https://radio.example/shows/news/").unwrap()
    }

    #[test]
    fn finds_alternate_feed_links() {
        let html = r#"<!doctype html><html><head>
          <title> News  hourly </title>
          <link rel="stylesheet" href="/a.css">
          <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments/feed/">
          <link rel="alternate" type="application/rss+xml" title="Podcast" href="feed.xml">
          <link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom">
          </head><body><link rel="alternate" type="application/rss+xml" href="/late"></body>"#;
        let (links, title) = discover_feed_links(html, &base());
        assert_eq!(
            links,
            vec![
                "https://radio.example/shows/news/feed.xml".to_string(),
                "https://cdn.example/atom".to_string(),
                "https://radio.example/comments/feed/".to_string(),
            ]
        );
        assert_eq!(title.as_deref(), Some("News hourly"));
    }

    #[test]
    fn apple_and_wordpress_patterns() {
        let apple = url::Url::parse("https://podcasts.apple.com/it/podcast/the-daily/id1200361736")
            .unwrap();
        assert!(matches!(
            known_patterns(&apple, None).first(),
            Some(KnownPattern::AppleLookup(id)) if id == "1200361736"
        ));
        assert_eq!(
            apple_lookup_url("1200361736", None),
            "https://itunes.apple.com/lookup?id=1200361736&entity=podcast"
        );
        let wp = url::Url::parse("https://radio.example/podcast/gr/").unwrap();
        assert!(matches!(
            known_patterns(&wp, Some("<link href='/wp-content/x.css'>")).first(),
            Some(KnownPattern::Feed(u)) if u == "https://radio.example/podcast/gr/feed/"
        ));
        let json = serde_json::json!({"results":[{"feedUrl":"https://feeds.example/daily"}]});
        assert_eq!(
            apple_feed_url(&json).as_deref(),
            Some("https://feeds.example/daily")
        );
    }

    #[test]
    fn parses_m3u_and_pls() {
        let m3u =
            "#EXTM3U\n#EXTINF:-1,Radio One\nhttp://stream.example:8000/live.mp3\n\nrelative.aac\n";
        assert_eq!(
            parse_playlist(m3u, &base()),
            vec![
                "http://stream.example:8000/live.mp3".to_string(),
                "https://radio.example/shows/news/relative.aac".to_string()
            ]
        );
        assert_eq!(playlist_title(m3u).as_deref(), Some("Radio One"));
        let pls = "[playlist]\nNumberOfEntries=2\nFile1=https://a.example/s1\nTitle1=Groove\nFile2=https://b.example/s2\nVersion=2\n";
        assert_eq!(
            parse_playlist(pls, &base()),
            vec![
                "https://a.example/s1".to_string(),
                "https://b.example/s2".to_string()
            ]
        );
        assert_eq!(playlist_title(pls).as_deref(), Some("Groove"));
        assert!(!is_hls(m3u));
        assert!(is_hls("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n"));
    }
}
