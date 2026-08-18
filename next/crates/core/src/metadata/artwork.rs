//! Artwork search + apply under album folders.

use crate::config::AppConfig;
use crate::db::Db;
use crate::path_util::{join_under_root, safe_rel_path, under_root};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const UA: &str = "RE-KORD/5.1 (studio artwork; +local)";

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

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}

fn host_blocked(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost"
        || h.starts_with("127.")
        || h.starts_with("10.")
        || h.starts_with("192.168.")
        || h.starts_with("169.254.")
        || h == "0.0.0.0"
        || h.ends_with(".local")
}

async fn itunes_art(q: &str) -> Result<Vec<ArtworkHit>> {
    let client = client()?;
    let res = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("term", q),
            ("entity", "album"),
            ("limit", "12"),
            ("country", "it"),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for r in data
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let art100 = r
            .get("artworkUrl100")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if art100.is_empty() {
            continue;
        }
        let artwork = art100.replace("100x100bb", "600x600bb");
        out.push(ArtworkHit {
            name: r
                .get("collectionName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artist: r
                .get("artistName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artwork: artwork.clone(),
            url: r
                .get("collectionViewUrl")
                .and_then(|v| v.as_str())
                .unwrap_or(&artwork)
                .to_string(),
            source: Some("itunes".into()),
        });
    }
    Ok(out)
}

async fn deezer_art(q: &str) -> Result<Vec<ArtworkHit>> {
    let client = client()?;
    let res = client
        .get("https://api.deezer.com/search/album")
        .query(&[("q", q), ("limit", "12")])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for r in data
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let artwork = r
            .get("cover_xl")
            .or_else(|| r.get("cover_big"))
            .or_else(|| r.get("cover_medium"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if artwork.is_empty() {
            continue;
        }
        out.push(ArtworkHit {
            name: r
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artist: r
                .pointer("/artist/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artwork: artwork.clone(),
            url: r
                .get("link")
                .and_then(|v| v.as_str())
                .unwrap_or(&artwork)
                .to_string(),
            source: Some("deezer".into()),
        });
    }
    Ok(out)
}

async fn coverart_archive(artist: &str, album: &str) -> Result<Vec<ArtworkHit>> {
    let client = client()?;
    let q = format!("artist:\"{artist}\" AND release:\"{album}\"");
    let res = client
        .get("https://musicbrainz.org/ws/2/release/")
        .query(&[("query", q.as_str()), ("fmt", "json"), ("limit", "3")])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for r in data
        .get("releases")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let artwork = format!("https://coverartarchive.org/release/{id}/front-500");
        // HEAD to check exists
        let head = client.head(&artwork).send().await;
        if let Ok(h) = head {
            if !h.status().is_success() {
                continue;
            }
        }
        out.push(ArtworkHit {
            name: r
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or(album)
                .to_string(),
            artist: artist.to_string(),
            artwork: artwork.clone(),
            url: artwork,
            source: Some("coverart".into()),
        });
    }
    Ok(out)
}

async fn discogs_art(cfg: &AppConfig, artist: &str, album: &str) -> Result<Vec<ArtworkHit>> {
    let client = client()?;
    let mut req = client
        .get("https://api.discogs.com/database/search")
        .query(&[
            ("artist", artist),
            ("release_title", album),
            ("type", "release"),
            ("per_page", "10"),
        ]);
    if let Some(tok) = &cfg.discogs_token {
        req = req.header("Authorization", format!("Discogs token={tok}"));
    }
    let res = req
        .header("Accept", "application/vnd.discogs.v2.discogs+json")
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for r in data
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let thumb = r
            .get("cover_image")
            .or_else(|| r.get("thumb"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if thumb.is_empty() || thumb.contains("spacer.gif") {
            continue;
        }
        let title = r
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(ArtworkHit {
            name: title.clone(),
            artist: artist.to_string(),
            artwork: thumb.clone(),
            url: thumb,
            source: Some("discogs".into()),
        });
    }
    Ok(out)
}

pub async fn search_artwork(
    cfg: &AppConfig,
    q: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<Vec<ArtworkHit>> {
    let query = q
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| match (artist, album) {
            (Some(a), Some(b)) if !a.trim().is_empty() && !b.trim().is_empty() => {
                Some(format!("{} {}", a.trim(), b.trim()))
            }
            (Some(a), _) if !a.trim().is_empty() => Some(a.trim().to_string()),
            _ => None,
        })
        .context("q or artist+album required")?;

    let artist_s = artist.unwrap_or("").trim();
    let album_s = album.unwrap_or("").trim();

    let mut out = Vec::new();
    if !artist_s.is_empty() && !album_s.is_empty() {
        if let Ok(mut d) = discogs_art(cfg, artist_s, album_s).await {
            out.append(&mut d);
        }
    }
    if let Ok(mut i) = itunes_art(&query).await {
        out.append(&mut i);
    }
    if let Ok(mut d) = deezer_art(&query).await {
        out.append(&mut d);
    }
    if !artist_s.is_empty() && !album_s.is_empty() {
        if let Ok(mut c) = coverart_archive(artist_s, album_s).await {
            out.append(&mut c);
        }
    }
    // Dedup by artwork URL
    let mut seen = std::collections::HashSet::new();
    out.retain(|h| seen.insert(h.artwork.clone()));
    out.truncate(40);
    Ok(out)
}

fn album_dir(music_root: &Path, album_path: &str) -> Result<PathBuf> {
    let rel = safe_rel_path(album_path)?;
    let abs = join_under_root(music_root, &rel)?;
    if !abs.is_dir() || !under_root(&abs, music_root) {
        bail!("album not found");
    }
    Ok(abs)
}

async fn download_image(url: &str) -> Result<(Vec<u8>, &'static str)> {
    let parsed = url::Url::parse(url).context("invalid image url")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        bail!("invalid scheme");
    }
    if host_blocked(parsed.host_str().unwrap_or("")) {
        bail!("blocked host");
    }
    let client = client()?;
    let res = client.get(url).send().await.context("fetch image")?;
    if !res.status().is_success() {
        bail!("image HTTP {}", res.status());
    }
    let ctype = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ctype.starts_with("image/") && !ctype.is_empty() {
        bail!("not an image");
    }
    let bytes = res.bytes().await?.to_vec();
    if bytes.len() < 64 || bytes.len() > 15 * 1024 * 1024 {
        bail!("invalid image size");
    }
    let ext = if ctype.contains("png") || url.to_ascii_lowercase().contains(".png") {
        "png"
    } else {
        "jpg"
    };
    Ok((bytes, ext))
}

fn write_cover(dir: &Path, bytes: &[u8], ext: &str) -> Result<PathBuf> {
    // Remove competing cover basenames lightly.
    for name in ["cover.jpg", "cover.png", "folder.jpg", "folder.png"] {
        let p = dir.join(name);
        if p.is_file() {
            let _ = fs::remove_file(p);
        }
    }
    let dest = dir.join(format!("cover.{ext}"));
    fs::write(&dest, bytes)?;
    Ok(dest)
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
    db.set_album_cover_path(&rel, &dest)?;
    Ok(serde_json::json!({
        "saved": true,
        "albumPath": rel,
        "abs": dest.to_string_lossy(),
        "coverRelPath": format!("{rel}/cover.{ext}"),
        "coverVersion": chrono::Utc::now().timestamp_millis(),
    }))
}

pub async fn upload_artwork(
    music_root: &Path,
    db: &Db,
    album_path: &str,
    bytes: &[u8],
    content_type: &str,
) -> Result<serde_json::Value> {
    if bytes.len() < 64 || bytes.len() > 15 * 1024 * 1024 {
        bail!("invalid image size");
    }
    let ext = if content_type.contains("png") {
        "png"
    } else {
        "jpg"
    };
    let dir = album_dir(music_root, album_path)?;
    let dest = write_cover(&dir, bytes, ext)?;
    let rel = safe_rel_path(album_path)?;
    db.set_album_cover_path(&rel, &dest)?;
    Ok(serde_json::json!({
        "saved": true,
        "albumPath": rel,
        "abs": dest.to_string_lossy(),
        "coverRelPath": format!("{rel}/cover.{ext}"),
        "coverVersion": chrono::Utc::now().timestamp_millis(),
    }))
}
