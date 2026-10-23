//! Artwork search + apply under album folders.

use super::error::{MetaError, SourceError};
use super::http::get_json;
use crate::config::AppConfig;
use crate::db::Db;
use crate::path_util::{join_under_root, safe_rel_path, under_root};
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn ua() -> String {
    crate::net::user_agent("studio artwork")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkHit {
    pub name: String,
    pub artist: String,
    pub artwork: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Hard cap for downloaded artwork (bytes are streamed, never buffered past it).
pub const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

/// Host names that always mean "this machine or its network" (SSRF guard).
pub fn host_name_blocked(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    h.is_empty()
        || h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".home.arpa")
}

fn ipv4_blocked(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        // CGNAT 100.64.0.0/10
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        // IETF protocol assignments 192.0.0.0/24
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // Benchmarking 198.18.0.0/15
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        // Reserved 240.0.0.0/4
        || o[0] >= 240
}

/// Loopback / private / link-local / CGNAT / ULA and every IPv6 form that
/// embeds an IPv4 address (mapped, compatible, NAT64, 6to4) are refused.
pub fn ip_blocked(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_blocked(v4),
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ipv4_blocked(v4);
            }
            let seg = v6.segments();
            if v6.is_unspecified() || v6.is_loopback() || v6.is_multicast() {
                return true;
            }
            // IPv4-compatible ::a.b.c.d (deprecated) and NAT64 64:ff9b::/96.
            if seg[..6] == [0, 0, 0, 0, 0, 0] || seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let o = v6.octets();
                return ipv4_blocked(std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]));
            }
            // 6to4 2002::/16 embeds the IPv4 in bits 16..48.
            if seg[0] == 0x2002 {
                let o = v6.octets();
                return ipv4_blocked(std::net::Ipv4Addr::new(o[2], o[3], o[4], o[5]));
            }
            (seg[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (seg[0] & 0xffc0) == 0xfec0 // site-local fec0::/10
                || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
                || (seg[0] == 0x2001 && seg[1] == 0) // Teredo
        }
    }
}

/// Resolve `url`'s host and return one public address to pin the connection
/// to (prevents DNS rebinding between the check and the request).
async fn public_addr_for(url: &url::Url) -> Result<std::net::SocketAddr> {
    let port = url
        .port_or_known_default()
        .ok_or_else(|| MetaError::invalid_url().err())?;
    let host = match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            let ip = std::net::IpAddr::V4(ip);
            if ip_blocked(ip) {
                return Err(MetaError::url_host_not_allowed().err());
            }
            return Ok(std::net::SocketAddr::new(ip, port));
        }
        Some(url::Host::Ipv6(ip)) => {
            let ip = std::net::IpAddr::V6(ip);
            if ip_blocked(ip) {
                return Err(MetaError::url_host_not_allowed().err());
            }
            return Ok(std::net::SocketAddr::new(ip, port));
        }
        Some(url::Host::Domain(d)) => d.to_string(),
        None => return Err(MetaError::invalid_url().err()),
    };
    if host_name_blocked(&host) {
        return Err(MetaError::url_host_not_allowed().err());
    }
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| MetaError::image_fetch_failed(format!("resolve: {e}")).err())?
        .collect();
    if addrs.is_empty() {
        return Err(MetaError::image_fetch_failed("host did not resolve").err());
    }
    // Any internal answer poisons the name (split-horizon / rebinding tricks).
    if addrs.iter().any(|a| ip_blocked(a.ip())) {
        return Err(MetaError::url_host_not_allowed().err());
    }
    Ok(addrs[0])
}

/// Download an image from an untrusted URL: http(s) only, public addresses
/// only (re-checked on every redirect, at most 3), body streamed with a hard
/// cap of `max_bytes`. Returns the bytes and the response content type.
pub async fn fetch_public_image(raw_url: &str, max_bytes: usize) -> Result<(Vec<u8>, String)> {
    use futures::StreamExt;
    let mut url = url::Url::parse(raw_url.trim()).map_err(|_| MetaError::invalid_url().err())?;
    for _ in 0..=MAX_REDIRECTS {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(MetaError::invalid_url().err());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(MetaError::invalid_url().err());
        }
        let addr = public_addr_for(&url).await?;
        let mut builder = reqwest::Client::builder()
            .user_agent(ua())
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(domain) = url.domain() {
            builder = builder.resolve(domain, addr);
        }
        let client = builder.build()?;
        let res = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| MetaError::image_fetch_failed(e).err())?;
        if res.status().is_redirection() {
            let Some(loc) = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return Err(MetaError::image_fetch_failed("redirect without location").err());
            };
            url = url
                .join(loc)
                .map_err(|_| MetaError::image_fetch_failed("bad redirect location").err())?;
            continue;
        }
        if !res.status().is_success() {
            return Err(MetaError::image_fetch_failed(format!("HTTP {}", res.status())).err());
        }
        let ctype = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !ctype.is_empty() && !ctype.starts_with("image/") {
            return Err(MetaError::image_invalid().err());
        }
        if res.content_length().is_some_and(|n| n > max_bytes as u64) {
            return Err(MetaError::image_too_large().err());
        }
        let mut body = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| MetaError::image_fetch_failed(e).err())?;
            if body.len() + chunk.len() > max_bytes {
                return Err(MetaError::image_too_large().err());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((body, ctype));
    }
    Err(MetaError::image_fetch_failed("too many redirects").err())
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn itunes_hits(data: &Value) -> Vec<ArtworkHit> {
    let mut out = Vec::new();
    for r in data
        .get("results")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let art100 = str_of(r, "artworkUrl100");
        if art100.is_empty() {
            continue;
        }
        let artwork = art100.replace("100x100bb", "600x600bb");
        let url = Some(str_of(r, "collectionViewUrl"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| artwork.clone());
        out.push(ArtworkHit {
            name: str_of(r, "collectionName"),
            artist: str_of(r, "artistName"),
            artwork,
            url,
            source: Some("itunes".into()),
        });
    }
    out
}

fn deezer_hits(data: &Value) -> Vec<ArtworkHit> {
    let mut out = Vec::new();
    for r in data
        .get("data")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let artwork = ["cover_xl", "cover_big", "cover_medium"]
            .iter()
            .map(|k| str_of(r, k))
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        if artwork.is_empty() {
            continue;
        }
        let url = Some(str_of(r, "link"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://www.deezer.com".into());
        out.push(ArtworkHit {
            name: str_of(r, "title"),
            artist: r
                .pointer("/artist/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artwork,
            url,
            source: Some("deezer".into()),
        });
    }
    out
}

/// Cover Art Archive fronts of MusicBrainz releases (checked with HEAD).
async fn coverart_hits(data: &Value) -> Vec<ArtworkHit> {
    let mut out = Vec::new();
    for r in data
        .get("releases")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .take(4)
    {
        let id = str_of(r, "id");
        if id.is_empty() {
            continue;
        }
        let artwork = format!("https://coverartarchive.org/release/{id}/front-500");
        if let Ok(h) = super::http::client().head(&artwork).send().await {
            if !h.status().is_success() {
                continue;
            }
        }
        out.push(ArtworkHit {
            name: str_of(r, "title"),
            artist: {
                let a = super::matching::musicbrainz_artist_credit(r);
                if a.is_empty() {
                    "—".into()
                } else {
                    a
                }
            },
            artwork,
            url: format!("https://musicbrainz.org/release/{id}"),
            source: Some("coverart".into()),
        });
    }
    out
}

/// "Artist — Album" / "Artist - Album" free text → (artist, album).
pub fn split_artist_album(q: &str) -> Option<(String, String)> {
    for sep in [" — ", " – ", " - "] {
        if let Some((a, b)) = q.split_once(sep) {
            let (a, b) = (a.trim(), b.trim());
            if !a.is_empty() && !b.is_empty() {
                return Some((a.to_string(), b.to_string()));
            }
        }
    }
    None
}

/// Search terms plus the (artist, album) pair when known.
pub type ArtworkTerms = (Vec<String>, Option<(String, String)>);

/// Search terms (legacy route): the free text, else "artist album",
/// "artist", "album"; plus the (artist, album) pair when known or derivable
/// from the text. `query_too_short` when nothing of 2+ chars is left.
pub fn artwork_terms(
    q: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<ArtworkTerms> {
    let q = q.map(str::trim).unwrap_or("");
    let artist = artist.map(str::trim).unwrap_or("");
    let album = album.map(str::trim).unwrap_or("");
    let given_pair =
        (!artist.is_empty() && !album.is_empty()).then(|| (artist.to_string(), album.to_string()));
    let mut terms: Vec<String> = Vec::new();
    let pair = if !q.is_empty() {
        terms.push(q.to_string());
        split_artist_album(q).or(given_pair)
    } else {
        let both = [artist, album]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        for t in [both.as_str(), artist, album] {
            if !t.is_empty() {
                terms.push(t.to_string());
            }
        }
        given_pair
    };
    let mut seen = std::collections::HashSet::new();
    terms.retain(|t| t.chars().count() > 1 && seen.insert(t.to_lowercase()));
    if terms.is_empty() {
        return Err(MetaError::query_too_short().err());
    }
    Ok((terms, pair))
}

/// Artwork search outcome: hits plus the sources that failed.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ArtworkSearchResult {
    pub results: Vec<ArtworkHit>,
    pub errors: Vec<SourceError>,
}

/// Discogs (with a token), iTunes, Deezer and MusicBrainz / Cover Art
/// Archive. Free text uses Discogs and CAA too: "Artist - Album" is split
/// into the pair, otherwise their free-text search is used.
pub async fn search_artwork_detailed(
    cfg: &AppConfig,
    q: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<ArtworkSearchResult> {
    let (terms, pair) = artwork_terms(q, artist, album)?;
    let mut out: Vec<ArtworkHit> = Vec::new();
    let mut errors: Vec<SourceError> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |out: &mut Vec<ArtworkHit>, h: ArtworkHit| {
        if !h.artwork.is_empty() && seen.insert(h.artwork.clone()) {
            out.push(h);
        }
    };

    if super::providers::discogs_configured(cfg) {
        let res = match &pair {
            Some((a, b)) => super::providers::discogs_search_releases(cfg, a, b).await,
            None => super::providers::discogs_search_free_text(cfg, &terms[0]).await,
        };
        match res {
            Ok(cands) => {
                for c in cands.into_iter().take(12) {
                    let Some(art) = c.cover_image.clone().or(c.thumb.clone()) else {
                        continue;
                    };
                    let (ca, cb) = c
                        .title
                        .split_once(" - ")
                        .map(|(a, b)| (a.trim().to_string(), b.trim().to_string()))
                        .unwrap_or_else(|| (String::new(), c.title.clone()));
                    push(
                        &mut out,
                        ArtworkHit {
                            name: cb,
                            artist: ca,
                            artwork: art,
                            url: c.uri.unwrap_or_else(|| "https://www.discogs.com".into()),
                            source: Some("discogs".into()),
                        },
                    );
                }
            }
            Err(e) => {
                let (_, code, msg) = super::error::classify(&e);
                errors.push(SourceError::new("discogs", code, msg));
            }
        }
    }

    // Leave room for the later sources (Cover Art Archive is last).
    for term in &terms {
        if out.len() >= 24 {
            break;
        }
        match get_json(
            "itunes",
            "https://itunes.apple.com/search",
            &[
                ("term", term.as_str()),
                ("entity", "album"),
                ("limit", "18"),
                ("country", "it"),
            ],
            None,
        )
        .await
        {
            Ok(d) => itunes_hits(&d).into_iter().for_each(|h| push(&mut out, h)),
            Err(e) => {
                errors.push(e);
                break;
            }
        }
    }

    out.truncate(24);
    for term in &terms {
        if out.len() >= 34 {
            break;
        }
        match get_json(
            "deezer",
            "https://api.deezer.com/search/album",
            &[("q", term.as_str()), ("limit", "20")],
            None,
        )
        .await
        {
            Ok(d) => deezer_hits(&d).into_iter().for_each(|h| push(&mut out, h)),
            Err(e) => {
                errors.push(e);
                break;
            }
        }
    }

    out.truncate(34);
    let mb_query = match &pair {
        Some((a, b)) => Some(format!(
            "release:\"{}\" AND artist:\"{}\"",
            b.replace('"', " "),
            a.replace('"', " ")
        )),
        None => terms.first().filter(|t| t.chars().count() >= 3).cloned(),
    };
    if let Some(query) = mb_query {
        match get_json(
            "musicbrainz",
            "https://musicbrainz.org/ws/2/release/",
            &[("query", query.as_str()), ("fmt", "json"), ("limit", "4")],
            None,
        )
        .await
        {
            Ok(d) => coverart_hits(&d)
                .await
                .into_iter()
                .for_each(|h| push(&mut out, h)),
            Err(e) => errors.push(SourceError::new("coverart", &e.code, e.message)),
        }
    }
    out.truncate(40);
    Ok(ArtworkSearchResult {
        results: out,
        errors,
    })
}

/// Compatibility wrapper: hits only.
pub async fn search_artwork(
    cfg: &AppConfig,
    q: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<Vec<ArtworkHit>> {
    Ok(search_artwork_detailed(cfg, q, artist, album)
        .await?
        .results)
}

fn album_dir(music_root: &Path, album_path: &str) -> Result<PathBuf> {
    let rel = safe_rel_path(album_path).map_err(|_| MetaError::invalid_path().err())?;
    if rel.is_empty() {
        return Err(MetaError::album_path_required().err());
    }
    let abs = join_under_root(music_root, &rel).map_err(|_| MetaError::invalid_path().err())?;
    if !abs.is_dir() || !under_root(&abs, music_root) {
        return Err(MetaError::album_not_found().err());
    }
    Ok(abs)
}

/// Image kind from the magic bytes (the extension must not lie).
fn sniff_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// JPEG/PNG kept as-is; anything else decodable (WebP) becomes a JPEG.
fn normalize_cover(bytes: Vec<u8>) -> Result<(Vec<u8>, &'static str)> {
    if bytes.len() < 64 {
        return Err(MetaError::image_invalid().err());
    }
    match sniff_image_ext(&bytes) {
        Some(ext @ ("jpg" | "png")) => Ok((bytes, ext)),
        Some(_) => {
            let img =
                image::load_from_memory(&bytes).map_err(|_| MetaError::image_invalid().err())?;
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
                .encode_image(&img.to_rgb8())
                .map_err(|_| MetaError::image_invalid().err())?;
            Ok((out, "jpg"))
        }
        None => Err(MetaError::image_invalid().err()),
    }
}

async fn download_image(url: &str) -> Result<(Vec<u8>, &'static str)> {
    let (bytes, _ctype) = fetch_public_image(url, MAX_IMAGE_BYTES).await?;
    normalize_cover(bytes)
}

fn write_cover(dir: &Path, bytes: &[u8], ext: &str) -> Result<PathBuf> {
    let dest = dir.join(format!("cover.{ext}"));
    // The hub's own write: the library watcher must not re-index for it
    // (the album row is updated right after).
    crate::watcher::own_write(&dest, || super::sidecar::write_atomic(&dest, bytes))?;
    // Remove competing cover basenames once the new one is in place.
    for name in ["cover.jpg", "cover.png", "folder.jpg", "folder.png"] {
        let p = dir.join(name);
        if p != dest && p.is_file() {
            let _ = crate::watcher::own_remove(&p);
        }
    }
    Ok(dest)
}

fn cover_response(rel: &str, ext: &str, version: Option<String>) -> serde_json::Value {
    // Never the absolute server path. `coverVersion` is the album's new
    // `cover_version` (what `/albums` and `/tracks` report from now on), so a
    // client can patch its lists and cover URLs right away.
    let version = version.unwrap_or_else(|| chrono::Utc::now().timestamp_millis().to_string());
    serde_json::json!({
        "saved": true,
        "albumPath": rel,
        "coverRelPath": format!("{rel}/cover.{ext}"),
        "coverVersion": version,
    })
}

pub async fn apply_artwork_url(
    music_root: &Path,
    db: &Db,
    album_path: &str,
    image_url: &str,
) -> Result<serde_json::Value> {
    let dir = album_dir(music_root, album_path)?;
    let (bytes, ext) = download_image(image_url).await?;
    let dest = write_cover(&dir, &bytes, ext)?;
    let rel = safe_rel_path(album_path)?;
    let version = db.set_album_cover_path(&rel, &dest)?;
    Ok(cover_response(&rel, ext, version))
}

pub async fn upload_artwork(
    music_root: &Path,
    db: &Db,
    album_path: &str,
    bytes: &[u8],
    _content_type: &str,
) -> Result<serde_json::Value> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(MetaError::image_too_large().err());
    }
    let dir = album_dir(music_root, album_path)?;
    let (bytes, ext) = normalize_cover(bytes.to_vec())?;
    let dest = write_cover(&dir, &bytes, ext)?;
    let rel = safe_rel_path(album_path)?;
    let version = db.set_album_cover_path(&rel, &dest)?;
    Ok(cover_response(&rel, ext, version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn blocked(s: &str) -> bool {
        ip_blocked(s.parse::<IpAddr>().unwrap())
    }

    #[test]
    fn internal_ranges_are_blocked() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::",
        ] {
            assert!(blocked(ip), "{ip} must be blocked");
        }
    }

    #[test]
    fn public_ranges_pass() {
        for ip in ["8.8.8.8", "172.32.0.1", "151.101.1.1", "2a00:1450:4001::1"] {
            assert!(!blocked(ip), "{ip} must pass");
        }
    }

    #[test]
    fn free_text_terms_derive_artist_and_album() {
        let (terms, pair) = artwork_terms(Some("Eagles - Desperado"), None, None).unwrap();
        assert_eq!(terms, vec!["Eagles - Desperado"]);
        assert_eq!(pair, Some(("Eagles".into(), "Desperado".into())));
        let (terms, pair) = artwork_terms(None, Some("Eagles"), Some("Desperado")).unwrap();
        assert_eq!(terms, vec!["Eagles Desperado", "Eagles", "Desperado"]);
        assert!(pair.is_some());
        let (_, pair) = artwork_terms(Some("desperado"), None, None).unwrap();
        assert!(pair.is_none());
        let e = artwork_terms(Some("x"), None, None).unwrap_err();
        assert_eq!(crate::metadata::error::classify(&e).1, "query_too_short");
    }

    #[test]
    fn cover_bytes_are_sniffed() {
        assert!(normalize_cover(vec![0u8; 100]).is_err());
        let mut png = vec![0x89, b'P', b'N', b'G'];
        png.resize(100, 0);
        assert_eq!(normalize_cover(png).unwrap().1, "png");
        let v = cover_response("A/B", "jpg", Some("18f-2a".into()));
        assert!(v.get("abs").is_none());
        assert_eq!(v["coverVersion"], "18f-2a");
        let fallback = cover_response("A/B", "jpg", None);
        assert!(fallback["coverVersion"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
    }

    #[tokio::test]
    async fn literal_internal_urls_are_refused_before_connecting() {
        for u in [
            "http://127.0.0.1/x.jpg",
            "http://[::1]/x.jpg",
            "http://localhost/x.jpg",
            "http://169.254.169.254/latest",
            "file:///etc/passwd",
        ] {
            let e = fetch_public_image(u, 1024).await.unwrap_err();
            let code = crate::metadata::error::classify(&e).1;
            assert!(
                code == "url_host_not_allowed" || code == "invalid_url",
                "{u}: {code}"
            );
        }
    }
}
