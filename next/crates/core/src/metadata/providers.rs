//! External metadata providers (Discogs, MusicBrainz, iTunes, Deezer, TheAudioDB).

use crate::config::AppConfig;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "RE-KORD/5.1 (studio metadata; +local)";

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()?)
}

fn itunes_countries() -> Vec<&'static str> {
    std::env::var("ITUNES_STORE_COUNTRIES")
        .ok()
        .map(|s| {
            let owned: Vec<String> = s
                .split(',')
                .map(|x| x.trim().to_lowercase())
                .filter(|x| !x.is_empty())
                .collect();
            // leak-free: just use defaults if custom parsing is awkward
            if owned.is_empty() {
                return vec!["it", "us", "gb", "de", "fr"];
            }
            // We can't return owned &'static; fall through to default.
            vec!["it", "us", "gb", "de", "fr"]
        })
        .unwrap_or_else(|| vec!["it", "us", "gb", "de", "fr"])
}

fn theaudiodb_key() -> String {
    std::env::var("THEAUDIODB_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "2".into())
}

/// Extra Discogs fields stored in `albums.discogs_extra_json` / sidecar (camelCase, legacy parity).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscogsAlbumExtra {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discogs_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_no: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchedAlbumMeta {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub musicbrainz_release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discogs_release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discogs_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discogs_extra: Option<DiscogsAlbumExtra>,
    /// Raw JSON blob for DB (`discogs_extra_json`); preferred over re-serializing `discogs_extra`.
    #[serde(skip)]
    pub discogs_extra_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_track_count: Option<i64>,
}

impl FetchedAlbumMeta {
    /// JSON to persist in `albums.discogs_extra_json` (raw import blob, else typed extra).
    pub fn discogs_extra_json_for_db(&self) -> Option<String> {
        if let Some(raw) = self
            .discogs_extra_json
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return Some(raw.to_string());
        }
        self.discogs_extra
            .as_ref()
            .and_then(|e| serde_json::to_string(e).ok())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchedTrackMeta {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscogsReleaseCandidate {
    pub release_id: i64,
    pub title: String,
    pub year: Option<String>,
    pub thumb: Option<String>,
    pub uri: Option<String>,
    pub score: i64,
    pub country: Option<String>,
    pub label: Option<String>,
}

fn discogs_headers(cfg: &AppConfig) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::ACCEPT,
        "application/vnd.discogs.v2.discogs+json".parse().unwrap(),
    );
    if let Some(tok) = &cfg.discogs_token {
        if let Ok(v) = format!("Discogs token={tok}").parse() {
            h.insert(reqwest::header::AUTHORIZATION, v);
        }
    }
    h
}

pub async fn discogs_search_releases(
    cfg: &AppConfig,
    artist: &str,
    album: &str,
) -> Result<Vec<DiscogsReleaseCandidate>> {
    let client = client()?;
    let url = "https://api.discogs.com/database/search";
    let res = client
        .get(url)
        .headers(discogs_headers(cfg))
        .query(&[
            ("artist", artist),
            ("release_title", album),
            ("type", "release"),
            ("per_page", "15"),
        ])
        .send()
        .await
        .context("discogs search")?;
    if res.status().as_u16() == 429 {
        bail!("Discogs rate limit");
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for r in data
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        if id <= 0 {
            continue;
        }
        let title = r
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let score = score_candidate(artist, album, &title);
        out.push(DiscogsReleaseCandidate {
            release_id: id,
            title,
            year: r.get("year").map(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| v.to_string())
            }),
            thumb: r
                .get("thumb")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            uri: r.get("uri").and_then(|v| v.as_str()).map(|s| {
                if s.starts_with("http") {
                    s.to_string()
                } else {
                    format!("https://www.discogs.com{s}")
                }
            }),
            score,
            country: r
                .get("country")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            label: r
                .get("label")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    out.sort_by(|a, b| b.score.cmp(&a.score));
    Ok(out)
}

fn score_candidate(artist: &str, album: &str, title: &str) -> i64 {
    let t = title.to_lowercase();
    let a = artist.to_lowercase();
    let al = album.to_lowercase();
    let mut score = 0i64;
    if t.contains(&a) {
        score += 40;
    }
    if t.contains(&al) {
        score += 40;
    }
    if !a.is_empty() && t.starts_with(&a) {
        score += 10;
    }
    score
}

fn discogs_format_summary(formats: &Value) -> Option<String> {
    let arr = formats.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let parts: Vec<String> = arr
        .iter()
        .filter_map(|f| {
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = f
                .get("descriptions")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let qty = f
                .get("qty")
                .and_then(|v| v.as_str())
                .filter(|q| *q != "1")
                .map(|q| format!(" x{q}"))
                .unwrap_or_default();
            let head = [name, desc.as_str()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            if head.is_empty() {
                None
            } else {
                Some(format!("{head}{qty}"))
            }
        })
        .collect();
    let s = parts.join(" · ");
    if s.is_empty() {
        None
    } else {
        Some(s.chars().take(300).collect())
    }
}

fn discogs_catalog_no(data: &Value) -> Option<String> {
    data.pointer("/labels/0/catno")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect())
}

pub async fn discogs_apply_release(
    cfg: &AppConfig,
    release_id: i64,
    artist: &str,
    album: &str,
) -> Result<FetchedAlbumMeta> {
    let client = client()?;
    let res = client
        .get(format!("https://api.discogs.com/releases/{release_id}"))
        .headers(discogs_headers(cfg))
        .send()
        .await
        .context("discogs release")?;
    if !res.status().is_success() {
        bail!("Discogs release HTTP {}", res.status());
    }
    let data: Value = res.json().await?;
    let title = data
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(album)
        .to_string();
    let score = score_candidate(artist, album, &title);
    if score < 25 && !artist.is_empty() && !album.is_empty() {
        bail!("Discogs match score too low ({score})");
    }
    let tracklist = data.get("tracklist").and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter(|t| t.get("type_").and_then(|x| x.as_str()) != Some("heading"))
            .count() as i64
    });
    let genre = data
        .get("genres")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let label = data
        .pointer("/labels/0/name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let discogs_uri = data
        .get("uri")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            data.get("resource_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| Some(format!("https://www.discogs.com/release/{release_id}")));
    let format_summary = data.get("formats").and_then(discogs_format_summary);
    let catalog_no = discogs_catalog_no(&data);
    let master_id = data.get("master_id").and_then(|v| v.as_i64());
    let discogs_extra = Some(DiscogsAlbumExtra {
        master_id,
        discogs_uri: discogs_uri.clone(),
        format_summary,
        catalog_no,
    });
    Ok(FetchedAlbumMeta {
        ok: true,
        title: Some(title),
        release_date: data
            .get("released")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        genre,
        label,
        country: data
            .get("country")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        source: Some("discogs".into()),
        musicbrainz_release_id: None,
        discogs_release_id: Some(release_id.to_string()),
        discogs_uri,
        discogs_extra,
        discogs_extra_json: None,
        expected_track_count: tracklist,
    })
}

async fn musicbrainz_album(artist: &str, album: &str) -> Result<Option<FetchedAlbumMeta>> {
    let client = client()?;
    let q = format!("artist:\"{artist}\" AND release:\"{album}\"");
    let res = client
        .get("https://musicbrainz.org/ws/2/release/")
        .query(&[("query", q.as_str()), ("fmt", "json"), ("limit", "5")])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let data: Value = res.json().await?;
    let Some(rel) = data
        .get("releases")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
    else {
        return Ok(None);
    };
    let id = rel
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Some(FetchedAlbumMeta {
        ok: true,
        title: rel
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_date: rel
            .get("date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        genre: None,
        label: None,
        country: rel
            .get("country")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        source: Some("musicbrainz".into()),
        musicbrainz_release_id: if id.is_empty() { None } else { Some(id) },
        discogs_release_id: None,
        discogs_uri: None,
        discogs_extra: None,
        discogs_extra_json: None,
        expected_track_count: None,
    }))
}

async fn itunes_album(artist: &str, album: &str) -> Result<Option<FetchedAlbumMeta>> {
    let client = client()?;
    let term = format!("{artist} {album}");
    for cc in itunes_countries() {
        let res = client
            .get("https://itunes.apple.com/search")
            .query(&[
                ("term", term.as_str()),
                ("entity", "album"),
                ("limit", "8"),
                ("country", cc),
            ])
            .send()
            .await?;
        if !res.status().is_success() {
            continue;
        }
        let data: Value = res.json().await?;
        if let Some(r) = data
            .get("results")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
        {
            return Ok(Some(FetchedAlbumMeta {
                ok: true,
                title: r
                    .get("collectionName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                release_date: r
                    .get("releaseDate")
                    .and_then(|v| v.as_str())
                    .map(|s| s.chars().take(10).collect()),
                genre: r
                    .get("primaryGenreName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                label: None,
                country: Some(cc.to_string()),
                source: Some("itunes".into()),
                musicbrainz_release_id: None,
                discogs_release_id: None,
                discogs_uri: None,
                discogs_extra: None,
                discogs_extra_json: None,
                expected_track_count: r.get("trackCount").and_then(|v| v.as_i64()),
            }));
        }
    }
    Ok(None)
}

async fn theaudiodb_album(artist: &str, album: &str) -> Result<Option<FetchedAlbumMeta>> {
    let client = client()?;
    let key = theaudiodb_key();
    let url = format!("https://www.theaudiodb.com/api/v1/json/{key}/searchalbum.php");
    let res = client
        .get(&url)
        .query(&[("s", artist), ("a", album)])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let data: Value = res.json().await?;
    let Some(r) = data
        .get("album")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
    else {
        return Ok(None);
    };
    Ok(Some(FetchedAlbumMeta {
        ok: true,
        title: r
            .get("strAlbum")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_date: r
            .get("intYearReleased")
            .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string()),
        genre: r
            .get("strGenre")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        label: r
            .get("strLabel")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        country: None,
        source: Some("theaudiodb".into()),
        musicbrainz_release_id: None,
        discogs_release_id: None,
        discogs_uri: None,
        discogs_extra: None,
        discogs_extra_json: None,
        expected_track_count: None,
    }))
}

fn merge_album(base: &mut FetchedAlbumMeta, other: FetchedAlbumMeta) {
    if base.title.is_none() {
        base.title = other.title;
    }
    if base.release_date.is_none() {
        base.release_date = other.release_date;
    }
    if base.genre.is_none() {
        base.genre = other.genre;
    }
    if base.label.is_none() {
        base.label = other.label;
    }
    if base.country.is_none() {
        base.country = other.country;
    }
    if base.musicbrainz_release_id.is_none() {
        base.musicbrainz_release_id = other.musicbrainz_release_id;
    }
    if base.discogs_release_id.is_none() {
        base.discogs_release_id = other.discogs_release_id;
    }
    if base.discogs_uri.is_none() {
        base.discogs_uri = other.discogs_uri;
    }
    if base.discogs_extra.is_none() {
        base.discogs_extra = other.discogs_extra;
    }
    if base.discogs_extra_json.is_none() {
        base.discogs_extra_json = other.discogs_extra_json;
    }
    if base.expected_track_count.is_none() {
        base.expected_track_count = other.expected_track_count;
    }
    if base.source.is_none() {
        base.source = other.source;
    }
    base.ok = true;
}

pub async fn fetch_album_meta(
    cfg: &AppConfig,
    artist: &str,
    album: &str,
) -> Result<FetchedAlbumMeta> {
    let mut meta = FetchedAlbumMeta {
        ok: false,
        ..Default::default()
    };
    // Discogs first
    if let Ok(cands) = discogs_search_releases(cfg, artist, album).await {
        if let Some(top) = cands.first() {
            if top.score >= 25 {
                if let Ok(d) = discogs_apply_release(cfg, top.release_id, artist, album).await {
                    meta = d;
                }
            }
        }
    }
    if let Ok(Some(mb)) = musicbrainz_album(artist, album).await {
        if meta.ok {
            merge_album(&mut meta, mb);
        } else {
            meta = mb;
        }
    }
    if !meta.ok || meta.expected_track_count.is_none() {
        if let Ok(Some(t)) = theaudiodb_album(artist, album).await {
            if meta.ok {
                merge_album(&mut meta, t);
            } else {
                meta = t;
            }
        }
    }
    if !meta.ok {
        if let Ok(Some(i)) = itunes_album(artist, album).await {
            meta = i;
        }
    } else if meta.genre.is_none() || meta.expected_track_count.is_none() {
        if let Ok(Some(i)) = itunes_album(artist, album).await {
            merge_album(&mut meta, i);
        }
    }
    if !meta.ok {
        bail!("no metadata found");
    }
    Ok(meta)
}

async fn deezer_track(artist: &str, title: &str) -> Result<Option<FetchedTrackMeta>> {
    let client = client()?;
    let q = format!("artist:\"{artist}\" track:\"{title}\"");
    let res = client
        .get("https://api.deezer.com/search/track")
        .query(&[("q", q.as_str()), ("limit", "10")])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let data: Value = res.json().await?;
    let Some(r) = data
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
    else {
        return Ok(None);
    };
    Ok(Some(FetchedTrackMeta {
        ok: true,
        title: r
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_date: None,
        genre: None,
        lyrics: None,
        track_number: r.get("track_position").and_then(|v| v.as_i64()),
        disc_number: r.get("disk_number").and_then(|v| v.as_i64()),
        source: Some("deezer".into()),
        url: r
            .get("link")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        duration_ms: r.get("duration").and_then(|v| v.as_i64()).map(|s| s * 1000),
    }))
}

async fn itunes_track(artist: &str, title: &str) -> Result<Option<FetchedTrackMeta>> {
    let client = client()?;
    let term = format!("{artist} {title}");
    for cc in itunes_countries() {
        let res = client
            .get("https://itunes.apple.com/search")
            .query(&[
                ("term", term.as_str()),
                ("entity", "song"),
                ("limit", "8"),
                ("country", cc),
            ])
            .send()
            .await?;
        if !res.status().is_success() {
            continue;
        }
        let data: Value = res.json().await?;
        if let Some(r) = data
            .get("results")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
        {
            return Ok(Some(FetchedTrackMeta {
                ok: true,
                title: r
                    .get("trackName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                release_date: r
                    .get("releaseDate")
                    .and_then(|v| v.as_str())
                    .map(|s| s.chars().take(10).collect()),
                genre: r
                    .get("primaryGenreName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                lyrics: None,
                track_number: r.get("trackNumber").and_then(|v| v.as_i64()),
                disc_number: r.get("discNumber").and_then(|v| v.as_i64()),
                source: Some("itunes".into()),
                url: r
                    .get("trackViewUrl")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                duration_ms: r.get("trackTimeMillis").and_then(|v| v.as_i64()),
            }));
        }
    }
    Ok(None)
}

async fn theaudiodb_track(artist: &str, title: &str) -> Result<Option<FetchedTrackMeta>> {
    let client = client()?;
    let key = theaudiodb_key();
    let url = format!("https://www.theaudiodb.com/api/v1/json/{key}/searchtrack.php");
    let res = client
        .get(&url)
        .query(&[("s", artist), ("t", title)])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let data: Value = res.json().await?;
    let Some(r) = data
        .get("track")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
    else {
        return Ok(None);
    };
    Ok(Some(FetchedTrackMeta {
        ok: true,
        title: r
            .get("strTrack")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_date: None,
        genre: r
            .get("strGenre")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        lyrics: r
            .get("strDescriptionEN")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        track_number: r
            .get("intTrackNumber")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())),
        disc_number: None,
        source: Some("theaudiodb".into()),
        url: None,
        duration_ms: r
            .get("intDuration")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())),
    }))
}

pub async fn fetch_track_meta(
    _cfg: &AppConfig,
    artist: &str,
    _album: &str,
    title: &str,
) -> Result<FetchedTrackMeta> {
    if let Ok(Some(d)) = deezer_track(artist, title).await {
        return Ok(d);
    }
    if let Ok(Some(t)) = theaudiodb_track(artist, title).await {
        return Ok(t);
    }
    if let Ok(Some(i)) = itunes_track(artist, title).await {
        return Ok(i);
    }
    bail!("no track metadata found");
}

/// LRCLIB lyrics fetch — parity with legacy `/api/track-lyrics/fetch`.
pub async fn fetch_track_lyrics_lrclib(
    artist: &str,
    title: &str,
    album: &str,
    duration_ms: Option<i64>,
) -> Result<(Option<String>, Option<String>)> {
    let ar = artist.trim();
    let tt = title.trim();
    let al = album.trim();
    if ar.is_empty() || tt.is_empty() {
        bail!("Missing artist or title");
    }
    let mut url = url::Url::parse("https://lrclib.net/api/get").context("lrclib url")?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("artist_name", ar);
        qp.append_pair("track_name", tt);
        if !al.is_empty() {
            qp.append_pair("album_name", al);
        }
        if let Some(ms) = duration_ms.filter(|v| *v > 0) {
            let dur_sec = ((ms as f64) / 1000.0).round().max(1.0) as i64;
            qp.append_pair("duration", &dur_sec.to_string());
        }
    }
    let client = client()?;
    let mut res = client.get(url.clone()).send().await?;
    for _ in 0..2 {
        if res.status().as_u16() != 503 && res.status().as_u16() != 429 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1100)).await;
        res = client.get(url.clone()).send().await?;
    }
    if res.status().as_u16() == 404 {
        return Ok((None, None));
    }
    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        let short = detail.trim().chars().take(220).collect::<String>();
        bail!(
            "LRCLIB {}{}",
            status.as_u16(),
            if short.is_empty() {
                String::new()
            } else {
                format!(": {short}")
            }
        );
    }
    let j: Value = res.json().await?;
    let synced = j
        .get("syncedLyrics")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let plain = j
        .get("plainLyrics")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok((synced, plain))
}

/// Wikipedia search for entity-info candidates.
pub async fn wikipedia_search(artist: &str, album: Option<&str>, lang: &str) -> Result<Vec<Value>> {
    let client = client()?;
    let lang = if lang == "en" { "en" } else { "it" };
    let query = match album {
        Some(a) if !a.trim().is_empty() => format!("{artist} {a}"),
        _ => artist.to_string(),
    };
    let search_url = format!("https://{lang}.wikipedia.org/w/api.php");
    let res = client
        .get(&search_url)
        .query(&[
            ("action", "query"),
            ("list", "search"),
            ("srsearch", query.as_str()),
            ("format", "json"),
            ("srlimit", "5"),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let data: Value = res.json().await?;
    let mut out = Vec::new();
    for hit in data
        .pointer("/query/search")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let title = hit
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if title.is_empty() {
            continue;
        }
        let extract_res = client
            .get(&search_url)
            .query(&[
                ("action", "query"),
                ("prop", "extracts"),
                ("exintro", "1"),
                ("explaintext", "1"),
                ("titles", title.as_str()),
                ("format", "json"),
            ])
            .send()
            .await;
        let Ok(er) = extract_res else { continue };
        let Ok(ed) = er.json::<Value>().await else {
            continue;
        };
        let text = ed
            .pointer("/query/pages")
            .and_then(|v| v.as_object())
            .and_then(|pages| pages.values().next())
            .and_then(|p| p.get("extract"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(2500)
            .collect::<String>();
        if text.len() < 40 {
            continue;
        }
        out.push(json!({
            "kind": if album.is_some() { "desc" } else { "bio" },
            "lang": lang,
            "title": title,
            "text": text,
        }));
    }
    Ok(out)
}
