//! Tags and covers for Studio downloads (5.2).
//!
//! yt-dlp downloads the audio and, when "Incorpora tag e copertina nei file
//! scaricati" is on, prints each item's metadata as one JSON line
//! (`--print after_move:[rekord-meta] …`). When the run is over the hub
//! fetches the thumbnail of every file this run downloaded and writes the
//! tags and the cover into it with lofty (the library already reads tags
//! with it). Nothing lands in the library but the audio files and
//! `cover.jpg` (yt-dlp's `--write-thumbnail` parks thumbnails next to the
//! audio while it works):
//!
//! - only files downloaded now: a file that was already there ("has already
//!   been downloaded") is never rewritten, which yt-dlp's own
//!   `--embed-metadata` / `--embed-thumbnail` would do (its post-processors
//!   also run on existing files);
//! - album and album artist come from the destination folder
//!   (`Artist/Album/…`), the values the library shows; title, main artist,
//!   date and genre from yt-dlp, cleaned (no " - Topic", no "(Official
//!   Video)"); upload dates are not used as release dates;
//! - the track number is the one in the file name (release order for an
//!   album, the folder's next free number for a single), so tag and name
//!   agree;
//! - the cover is the thumbnail cropped to a centred square (video
//!   thumbnails are 16:9) and kept at most [`COVER_MAX`] px; square art is
//!   embedded as it came. Album downloads also save it as `cover.jpg` in a
//!   folder that has no cover yet; an existing cover is never replaced;
//! - WebM (YouTube's fallback when no M4A exists) cannot carry tags lofty
//!   writes: its Opus stream is copied into an `.opus` file (no re-encode).

use crate::db::text::{album_display_title, fold_fullwidth_punct, guess_track_numbers};
use crate::ytdlp::ItemRecord;
use anyhow::{bail, Context, Result};
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Marker of the per-item metadata line (`--print after_move:…`).
pub const META_MARKER: &str = "[rekord-meta]";

/// yt-dlp fields printed after each item (missing ones are left out).
const META_FIELDS: &str = "id,title,track,artist,artists,album,album_artist,album_artists,\
release_date,release_year,playlist_index,n_entries,playlist_count,track_number,disc_number,\
genre,genres,uploader,channel,playlist_title,filepath,thumbnail,thumbnails";

/// Longest side of an embedded / saved cover.
pub const COVER_MAX: u32 = 1200;

/// JPEG quality of a cropped or resized cover.
const COVER_QUALITY: u8 = 90;

/// Thumbnails tried per item, best first.
const THUMB_TRIES: usize = 4;

/// Hosts thumbnails are fetched from (YouTube, SoundCloud, Bandcamp).
const THUMB_HOSTS: &[&str] = &[
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
    "sndcdn.com",
    "bcbits.com",
];

/// Largest thumbnail accepted.
pub const THUMB_MAX_BYTES: usize = 8 * 1024 * 1024;

/// `--print` value for the metadata line.
pub fn meta_print_arg() -> String {
    format!("after_move:{META_MARKER} %(.{{{META_FIELDS}}})j")
}

/// Thumbnail URLs of an item, best first: yt-dlp lists `thumbnails` from
/// worst to best. Only https URLs of the known image hosts.
pub fn thumbnail_urls(meta: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let listed = meta
        .get("thumbnails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|t| t.get("url").and_then(Value::as_str));
    let best = meta.get("thumbnail").and_then(Value::as_str);
    for u in listed.chain(best) {
        if urls.len() >= THUMB_TRIES {
            break;
        }
        if is_thumbnail_url(u) && !urls.iter().any(|x| x == u) {
            urls.push(u.to_string());
        }
    }
    urls
}

fn is_thumbnail_url(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw) else {
        return false;
    };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    u.scheme() == "https"
        && THUMB_HOSTS
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// Values written into one file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TagValues {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    pub disc: Option<u32>,
    /// `YYYY-MM-DD`, `YYYY-MM` or `YYYY`.
    pub date: Option<String>,
    pub genre: Option<String>,
}

fn str_field(meta: &Value, key: &str) -> Option<String> {
    let s = match meta.get(key)? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let t = collapse(&s);
    (!t.is_empty() && t != "NA").then_some(t)
}

fn list_field(meta: &Value, key: &str) -> Vec<String> {
    match meta.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(collapse)
            .filter(|s| !s.is_empty())
            .fold(Vec::new(), |mut out, s| {
                if !out.iter().any(|o: &String| o.eq_ignore_ascii_case(&s)) {
                    out.push(s);
                }
                out
            }),
        _ => Vec::new(),
    }
}

fn num_field(meta: &Value, key: &str) -> Option<u32> {
    match meta.get(key)? {
        Value::Number(n) => n.as_u64().and_then(|v| u32::try_from(v).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n| *n > 0)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Channel name → artist: `Artist - Topic` → `Artist`, `ArtistVEVO` →
/// `Artist`.
pub fn clean_artist_name(raw: &str) -> String {
    let s = collapse(raw);
    let s = s
        .strip_suffix(" - Topic")
        .map(str::trim_end)
        .unwrap_or(&s)
        .to_string();
    if let Some(head) = s.strip_suffix("VEVO") {
        let head = head.trim_end();
        if head.chars().count() >= 2 {
            return head.to_string();
        }
    }
    s
}

/// Auto-generated "Artist - Topic" channels belong to the artist itself.
fn is_topic_channel(name: &str) -> bool {
    name.trim_end().ends_with(" - Topic")
}

const NOISE_WORDS: &[&str] = &[
    "official",
    "ufficiale",
    "officiel",
    "oficial",
    "offiziell",
    "video",
    "videoclip",
    "audio",
    "lyric",
    "visuali",
    "testo",
    "letra",
    "songtext",
];
const NOISE_EXACT: &[&str] = &["hd", "hq", "4k", "mv", "m/v"];
/// A bracket with one of these describes the recording: never removed.
const KEEP_WORDS: &[&str] = &[
    "live",
    "remix",
    "mix",
    "edit",
    "version",
    "versione",
    "feat",
    "ft.",
    "acoustic",
    "acustic",
    "remaster",
    "cover",
    "unplugged",
    "demo",
    "instrumental",
    "session",
];

/// `(Official Video)`, `[HD]`, `Lyric Video`… but not `(Live)`,
/// `(Official Remix)` or `(feat. X)`.
fn is_noise_label(inner: &str) -> bool {
    let l = inner.trim().to_lowercase();
    if l.is_empty() {
        return false;
    }
    if KEEP_WORDS.iter().any(|w| l.contains(w)) {
        return false;
    }
    NOISE_EXACT.contains(&l.as_str()) || NOISE_WORDS.iter().any(|w| l.contains(w))
}

fn strip_noise_brackets(s: &str) -> String {
    let pairs = [('(', ')'), ('[', ']'), ('【', '】')];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    'outer: while !rest.is_empty() {
        for (open, close) in pairs {
            if rest.starts_with(open) {
                if let Some(end) = rest[open.len_utf8()..].find(close) {
                    let inner = &rest[open.len_utf8()..open.len_utf8() + end];
                    let after = &rest[open.len_utf8() + end + close.len_utf8()..];
                    if is_noise_label(inner) {
                        rest = after;
                        continue 'outer;
                    }
                }
            }
        }
        let c = rest.chars().next().unwrap_or(' ');
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// Title of a video upload without the parts that describe the upload:
/// noise brackets, `| Official Video` tails and a leading `Artist - ` when
/// it names one of `artists`. Never returns an empty title.
pub fn clean_video_title(raw: &str, artists: &[&str]) -> String {
    let original = collapse(raw);
    let mut s = strip_noise_brackets(&original);
    // "Song | Official Music Video"
    let mut parts: Vec<&str> = s.split(" | ").collect();
    while parts.len() > 1 && parts.last().is_some_and(|p| is_noise_label(p)) {
        parts.pop();
    }
    s = parts.join(" | ");
    s = collapse(&s);
    // "Artist - Song"
    for sep in [" - ", " – ", " — "] {
        if let Some((head, tail)) = s.split_once(sep) {
            let h = head.trim().to_lowercase();
            let named = artists.iter().any(|a| {
                let a = a.trim().to_lowercase();
                !a.is_empty()
                    && (h == a
                        || [" feat", " ft.", " ft ", " & ", " x ", ", ", " and ", " / "]
                            .iter()
                            .any(|j| h.starts_with(&format!("{a}{j}"))))
            });
            if named && !tail.trim().is_empty() {
                s = tail.trim().to_string();
            }
            break;
        }
    }
    let s = s
        .trim_matches(|c: char| c.is_whitespace() || c == '-' || c == '|' || c == '–')
        .to_string();
    if s.is_empty() {
        original
    } else {
        s
    }
}

/// `CD 2`, `Disc2`, `Disco 1` → disc number of a sub-folder.
fn disc_from_folder(name: &str) -> Option<u32> {
    let l = name.trim().to_lowercase();
    for prefix in ["cd", "disc", "disk", "disco", "disque"] {
        if let Some(rest) = l.strip_prefix(prefix) {
            let n = rest.trim_start_matches([' ', '-', '_', '.']);
            if !n.is_empty() && n.len() <= 2 && n.chars().all(|c| c.is_ascii_digit()) {
                return n.parse().ok().filter(|v| *v > 0);
            }
        }
    }
    None
}

fn is_playlist_kind(kind: &str) -> bool {
    kind != "download_single"
}

/// Tag values of one downloaded file. `rel_file` is the file's path under
/// the music root; its folders give album and album artist
/// (`Artist/Album[/CD 2]/07 - Title.m4a`), its name the track number.
pub fn tag_values(meta: &Value, rel_file: &str, kind: &str) -> TagValues {
    let rel = rel_file.replace('\\', "/");
    let mut segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let file_name = segs.pop().unwrap_or("");
    let stem = match file_name.rfind('.') {
        Some(i) if i > 0 => &file_name[..i],
        _ => file_name,
    };

    let mut folder_disc = None;
    let (folder_artist, folder_album) = if segs.len() >= 2 {
        if segs.len() >= 3 {
            folder_disc = disc_from_folder(segs[segs.len() - 1]);
        }
        (
            Some(collapse(&fold_fullwidth_punct(segs[0]))),
            Some(album_display_title(segs[1])),
        )
    } else {
        (None, None)
    };

    let uploader = str_field(meta, "uploader").or_else(|| str_field(meta, "channel"));
    let mut artists = list_field(meta, "artists");
    if artists.is_empty() {
        if let Some(a) = str_field(meta, "artist") {
            artists.push(a);
        }
    }
    // The main artist: YouTube's credit lists also name featured artists
    // and, for art tracks, songwriters.
    let artist = if let Some(first) = artists.first() {
        Some(first.clone())
    } else if let Some(u) = uploader.as_deref().filter(|u| is_topic_channel(u)) {
        Some(clean_artist_name(u))
    } else if let Some(fa) = folder_artist.clone() {
        Some(fa)
    } else {
        uploader.as_deref().map(clean_artist_name)
    };

    let album_artist = folder_artist.or_else(|| {
        list_field(meta, "album_artists")
            .into_iter()
            .next()
            .or_else(|| str_field(meta, "album_artist"))
            .or_else(|| artists.first().cloned())
            .or_else(|| artist.clone())
    });

    let album = folder_album.or_else(|| {
        str_field(meta, "album")
            .or_else(|| {
                is_playlist_kind(kind)
                    .then(|| str_field(meta, "playlist_title"))
                    .flatten()
            })
            .map(|a| album_display_title(&a))
    });

    let title = match str_field(meta, "track") {
        Some(t) => Some(t),
        None => str_field(meta, "title").map(|t| {
            let mut names: Vec<&str> = artists.iter().map(String::as_str).collect();
            if let Some(a) = artist.as_deref() {
                names.push(a);
            }
            if let Some(a) = album_artist.as_deref() {
                names.push(a);
            }
            let cleaned_uploader = uploader.as_deref().map(clean_artist_name);
            if let Some(u) = cleaned_uploader.as_deref() {
                names.push(u);
            }
            clean_video_title(&t, &names)
        }),
    };

    let (_, name_track) = guess_track_numbers(stem);
    let playlist_index = num_field(meta, "playlist_index");
    let track = name_track
        .and_then(|n| u32::try_from(n).ok())
        .or(if is_playlist_kind(kind) {
            playlist_index
        } else {
            None
        })
        .or_else(|| num_field(meta, "track_number"));
    let track_total = (is_playlist_kind(kind) && playlist_index.is_some())
        .then(|| num_field(meta, "n_entries").or_else(|| num_field(meta, "playlist_count")))
        .flatten()
        .filter(|total| track.is_none_or(|t| t <= *total));

    let date = str_field(meta, "release_date")
        .and_then(|d| crate::db::text::normalize_date(&d))
        .or_else(|| {
            num_field(meta, "release_year")
                .and_then(|y| crate::db::text::normalize_date(&y.to_string()))
        });

    let genre = str_field(meta, "genre").or_else(|| list_field(meta, "genres").into_iter().next());

    TagValues {
        title,
        artist,
        album_artist,
        album,
        track,
        track_total,
        disc: num_field(meta, "disc_number").or(folder_disc),
        date,
        genre,
    }
}

/// The cover as embedded: a centred square of at most [`COVER_MAX`] px,
/// JPEG. Square JPEG art within the limit is returned untouched.
pub fn square_cover(bytes: &[u8]) -> Result<Vec<u8>> {
    let format = image::guess_format(bytes).context("unknown image format")?;
    let img = image::load_from_memory_with_format(bytes, format).context("decode thumbnail")?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        bail!("empty thumbnail");
    }
    if w == h && w <= COVER_MAX && format == image::ImageFormat::Jpeg {
        return Ok(bytes.to_vec());
    }
    let side = w.min(h);
    let mut square = img.crop_imm((w - side) / 2, (h - side) / 2, side, side);
    if side > COVER_MAX {
        square = square.resize_exact(COVER_MAX, COVER_MAX, image::imageops::FilterType::Lanczos3);
    }
    let rgb = square.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, COVER_QUALITY)
        .encode_image(&rgb)
        .context("encode cover")?;
    Ok(out)
}

/// Write `values` (and the cover, as the front picture) into `path`.
pub fn write_tags(path: &Path, values: &TagValues, cover: Option<&[u8]>) -> Result<()> {
    let mut tagged = Probe::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .guess_file_type()?
        .read()
        .with_context(|| format!("read {}", path.display()))?;
    let tag_type = tagged.primary_tag_type();
    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let Some(tag) = tagged.tag_mut(tag_type) else {
        bail!("no writable tag");
    };
    if let Some(v) = &values.title {
        tag.set_title(v.clone());
    }
    if let Some(v) = &values.artist {
        tag.set_artist(v.clone());
    }
    if let Some(v) = &values.album_artist {
        tag.insert_text(ItemKey::AlbumArtist, v.clone());
    }
    if let Some(v) = &values.album {
        tag.set_album(v.clone());
    }
    if let Some(v) = values.track {
        tag.set_track(v);
    }
    if let Some(v) = values.track_total {
        tag.set_track_total(v);
    }
    if let Some(v) = values.disc {
        tag.set_disk(v);
    }
    if let Some(v) = &values.date {
        tag.insert_text(ItemKey::RecordingDate, v.clone());
    }
    if let Some(v) = &values.genre {
        tag.set_genre(v.clone());
    }
    if let Some(data) = cover {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            data.to_vec(),
        ));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .with_context(|| format!("write tags to {}", path.display()))?;
    Ok(())
}

/// Next track number of a folder for a single: one past the highest number
/// found in the file names (`07 - Title.m4a`), or in the tags of files whose
/// name has none. 1 for an empty or missing folder.
pub fn next_track_slot(dir: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 1;
    };
    let mut max = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !path.is_file() || !crate::layout::is_audio_name(name) {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let n = match guess_track_numbers(stem).1 {
            Some(n) => u32::try_from(n).ok(),
            None => crate::embedded::tags::read_file(
                &path,
                crate::embedded::tags::ReadRequest {
                    tags: true,
                    picture: false,
                    properties: false,
                },
            )
            .tags
            .track_number
            .and_then(|n| u32::try_from(n).ok()),
        };
        if let Some(n) = n.filter(|n| *n < 1000) {
            max = max.max(n);
        }
    }
    max + 1
}

/// Copy the audio stream of a WebM download into an `.opus` (or `.ogg`
/// for Vorbis) file next to it, then remove the WebM. Never replaces an
/// existing file. Returns the new path.
pub fn remux_webm(ffmpeg: &Path, path: &Path) -> Result<PathBuf> {
    for (ext, muxer) in [("opus", "opus"), ("ogg", "ogg")] {
        let dest = path.with_extension(ext);
        if dest.exists() {
            bail!("{} already exists", dest.display());
        }
        let tmp = path.with_extension(format!("{ext}.rekord-part"));
        let status = Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-i"])
            .arg(path)
            .args(["-map", "0:a:0", "-c:a", "copy", "-f", muxer])
            .arg(&tmp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("run ffmpeg")?;
        if status.success() && tmp.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            if dest.exists() {
                let _ = std::fs::remove_file(&tmp);
                bail!("{} already exists", dest.display());
            }
            std::fs::rename(&tmp, &dest).context("rename remuxed file")?;
            let _ = std::fs::remove_file(path);
            return Ok(dest);
        }
        let _ = std::fs::remove_file(&tmp);
    }
    bail!("ffmpeg could not copy the audio stream")
}

/// What the tagging pass did, for the `tagged` event and the `done` summary.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagReport {
    /// Files that received tags.
    pub tagged: usize,
    /// Files that received an embedded cover.
    pub covers: usize,
    /// `cover.jpg` files written (paths relative to the music root).
    pub cover_files: Vec<String>,
    /// WebM downloads copied into Opus: (old, new) relative paths.
    #[serde(skip)]
    pub renamed: Vec<(String, String)>,
    /// Files that could not be tagged (relative path, reason).
    pub failed: Vec<TagFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFailure {
    pub file: String,
    pub reason: String,
}

/// Inputs of [`finish_downloads`].
pub struct FinishJob<'a> {
    pub music_root: &'a Path,
    pub kind: &'a str,
    /// Fetch one thumbnail URL (`None`: not available).
    pub fetch: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    pub ffmpeg: Option<&'a Path>,
    /// Folder keys (`Artist/Album`) whose cover must not be replaced even
    /// though the folder has no image (legacy `.kord/artwork` covers).
    pub has_cover: &'a dyn Fn(&str) -> bool,
}

/// Album folder of a downloaded file: its folder, or the parent of a disc
/// sub-folder (`Artist/Album/CD 2/01 - x.m4a` → `Artist/Album`).
fn album_folder_of(rel_file: &str) -> Option<String> {
    let (dir, _) = rel_file.rsplit_once('/')?;
    match dir.rsplit_once('/') {
        Some((parent, last)) if parent.contains('/') && disc_from_folder(last).is_some() => {
            Some(parent.to_string())
        }
        _ => Some(dir.to_string()),
    }
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    (!s.is_empty()).then_some(s)
}

/// Tag and cover the files of the items downloaded in this run (blocking).
pub fn finish_downloads(job: &FinishJob<'_>, items: &[ItemRecord]) -> TagReport {
    let mut report = TagReport::default();
    // Album folder → (playlist index, cover) of its first track.
    let mut folder_covers: BTreeMap<String, (u32, Vec<u8>)> = BTreeMap::new();

    for item in items {
        if item.status != crate::ytdlp::ItemStatus::Downloaded {
            continue;
        }
        let Some(meta) = item.meta.as_ref() else {
            continue;
        };
        let Some(raw) = str_field(meta, "filepath").or_else(|| item.files.last().cloned()) else {
            continue;
        };
        let mut path = PathBuf::from(&raw);
        if path.is_relative() {
            path = job.music_root.join(path);
        }
        if !path.is_file() || !crate::path_util::under_root(&path, job.music_root) {
            continue;
        }
        let Some(mut rel) = rel_of(job.music_root, &path) else {
            continue;
        };

        let is_webm = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("webm"));
        if is_webm {
            let Some(ffmpeg) = job.ffmpeg else {
                report.failed.push(TagFailure {
                    file: rel,
                    reason: "webm_needs_ffmpeg".into(),
                });
                continue;
            };
            match remux_webm(ffmpeg, &path) {
                Ok(new_path) => {
                    let new_rel = rel_of(job.music_root, &new_path).unwrap_or_else(|| rel.clone());
                    report.renamed.push((rel.clone(), new_rel.clone()));
                    path = new_path;
                    rel = new_rel;
                }
                Err(e) => {
                    report.failed.push(TagFailure {
                        file: rel,
                        reason: format!("remux: {e}"),
                    });
                    continue;
                }
            }
        }

        let values = tag_values(meta, &rel, job.kind);
        let cover = thumbnail_urls(meta).iter().find_map(|url| {
            let bytes = (job.fetch)(url)?;
            match square_cover(&bytes) {
                Ok(c) => Some(c),
                Err(e) => {
                    tracing::debug!(error = %e, file = %rel, "download thumbnail unusable");
                    None
                }
            }
        });
        match write_tags(&path, &values, cover.as_deref()) {
            Ok(()) => {
                report.tagged += 1;
                if let Some(c) = cover {
                    report.covers += 1;
                    if is_playlist_kind(job.kind) {
                        if let Some(folder) = album_folder_of(&rel) {
                            let order = values.track.unwrap_or(u32::MAX);
                            let slot = folder_covers
                                .entry(folder)
                                .or_insert((u32::MAX, Vec::new()));
                            if order < slot.0 || slot.1.is_empty() {
                                *slot = (order, c);
                            }
                        }
                    }
                }
            }
            Err(e) => report.failed.push(TagFailure {
                file: rel,
                reason: format!("{e:#}"),
            }),
        }
    }

    for (folder, (_, cover)) in folder_covers {
        // Album folders only (`Artist/Album`), never the root or an artist.
        if folder.split('/').filter(|s| !s.is_empty()).count() < 2 {
            continue;
        }
        let dir = job.music_root.join(&folder);
        if crate::cover::find_cover_in_dir(&dir).is_some() || (job.has_cover)(&folder) {
            continue;
        }
        let dest = dir.join("cover.jpg");
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .and_then(|mut f| std::io::Write::write_all(&mut f, &cover));
        match written {
            Ok(()) => report.cover_files.push(format!("{folder}/cover.jpg")),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => tracing::warn!(error = %e, folder = %folder, "cannot save album cover"),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn artist_names_lose_channel_suffixes() {
        assert_eq!(clean_artist_name("Caparezza - Topic"), "Caparezza");
        assert_eq!(clean_artist_name("AdeleVEVO"), "Adele");
        assert_eq!(clean_artist_name("VEVO"), "VEVO");
        assert_eq!(clean_artist_name("  Måneskin  "), "Måneskin");
    }

    #[test]
    fn video_titles_lose_upload_noise_only() {
        let a = ["Måneskin"];
        assert_eq!(
            clean_video_title("Måneskin - ZITTI E BUONI (Official Video)", &a),
            "ZITTI E BUONI"
        );
        assert_eq!(clean_video_title("Song [HD] (Lyric Video)", &a), "Song");
        assert_eq!(clean_video_title("Song | Official Music Video", &a), "Song");
        assert_eq!(clean_video_title("Song (Live)", &a), "Song (Live)");
        assert_eq!(
            clean_video_title("Song (Official Remix)", &a),
            "Song (Official Remix)"
        );
        assert_eq!(
            clean_video_title("Song (feat. Someone)", &a),
            "Song (feat. Someone)"
        );
        assert_eq!(
            clean_video_title("Måneskin feat. Iggy Pop - I Wanna Be Your Slave", &a),
            "I Wanna Be Your Slave"
        );
        assert_eq!(
            clean_video_title("Måneskin / Other - Song (Official Music Video)", &a),
            "Song"
        );
        // Another artist's name before the dash stays: it may be the title.
        assert_eq!(clean_video_title("Other - Song", &a), "Other - Song");
        assert_eq!(
            clean_video_title("(Official Video)", &a),
            "(Official Video)"
        );
        assert_eq!(
            clean_video_title("Video Killed the Radio Star", &a),
            "Video Killed the Radio Star"
        );
    }

    #[test]
    fn album_track_takes_folder_album_and_release_order() {
        let meta = json!({
            "id": "abc", "title": "Song A", "track": "Song A",
            "artists": ["Main", "Guest"], "album": "Real Album",
            "uploader": "Main - Topic", "playlist_index": 3, "n_entries": 4,
            "playlist_title": "Album - Real Album", "release_date": "20190510",
        });
        let v = tag_values(
            &meta,
            "Main/Real Album/03 - Song A.m4a",
            "download_playlist",
        );
        assert_eq!(v.title.as_deref(), Some("Song A"));
        assert_eq!(v.artist.as_deref(), Some("Main"));
        assert_eq!(v.album_artist.as_deref(), Some("Main"));
        assert_eq!(v.album.as_deref(), Some("Real Album"));
        assert_eq!((v.track, v.track_total), (Some(3), Some(4)));
        assert_eq!(v.date.as_deref(), Some("2019-05-10"));
    }

    #[test]
    fn root_download_uses_release_album_not_playlist_prefix() {
        let meta = json!({
            "title": "Song", "uploader": "Band - Topic", "playlist_index": 2,
            "playlist_count": 5, "playlist_title": "Album - Live at Home", "release_year": 2001,
        });
        let v = tag_values(
            &meta,
            "Album - Live at Home/02 - Song.webm",
            "download_ytmusic",
        );
        assert_eq!(v.artist.as_deref(), Some("Band"));
        assert_eq!(v.album_artist.as_deref(), Some("Band"));
        assert_eq!(v.album.as_deref(), Some("Live at Home"));
        assert_eq!((v.track, v.track_total), (Some(2), Some(5)));
        assert_eq!(v.date.as_deref(), Some("2001"));
    }

    #[test]
    fn single_takes_folder_values_and_the_number_in_its_name() {
        let meta = json!({
            "title": "Artist X - New Song (Official Video)", "uploader": "Some Label",
            "upload_date": "20240101",
        });
        let v = tag_values(
            &meta,
            "Artist X/Best Of/12 - New Song.m4a",
            "download_single",
        );
        assert_eq!(v.title.as_deref(), Some("New Song"));
        // No artist credit: the folder's artist, not the label's channel.
        assert_eq!(v.artist.as_deref(), Some("Artist X"));
        assert_eq!(v.album.as_deref(), Some("Best Of"));
        assert_eq!((v.track, v.track_total), (Some(12), None));
        // Upload dates are not release dates.
        assert_eq!(v.date, None);
    }

    #[test]
    fn album_folder_skips_disc_folders() {
        assert_eq!(album_folder_of("A/B/01 - x.m4a").as_deref(), Some("A/B"));
        assert_eq!(
            album_folder_of("A/B/CD 2/01 - x.m4a").as_deref(),
            Some("A/B")
        );
        assert_eq!(
            album_folder_of("A/CD 2/01 - x.m4a").as_deref(),
            Some("A/CD 2")
        );
        assert_eq!(album_folder_of("x.m4a"), None);
    }

    #[test]
    fn disc_folder_gives_disc_number() {
        let meta = json!({ "title": "T", "playlist_index": 1 });
        let v = tag_values(&meta, "A/B/CD 2/01 - T.m4a", "download_playlist");
        assert_eq!(v.disc, Some(2));
        assert_eq!(v.album.as_deref(), Some("B"));
        assert_eq!(disc_from_folder("Disc1"), Some(1));
        assert_eq!(disc_from_folder("Discography"), None);
    }

    fn encode(img: image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn wide_thumbnails_are_cropped_to_a_centred_square() {
        // 1280×720 with a white square in the middle (pillarboxed art).
        let mut img = image::RgbImage::new(1280, 720);
        for (x, _, p) in img.enumerate_pixels_mut() {
            *p = if (280..1000).contains(&x) {
                image::Rgb([255, 255, 255])
            } else {
                image::Rgb([0, 0, 0])
            };
        }
        let bytes = encode(image::DynamicImage::ImageRgb8(img), image::ImageFormat::Png);
        let out = square_cover(&bytes).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (720, 720));
        assert_eq!(image::guess_format(&out).unwrap(), image::ImageFormat::Jpeg);
        // The bars are gone: the edges are white.
        let rgb = decoded.to_rgb8();
        assert!(rgb.get_pixel(2, 360).0[0] > 200);
        assert!(rgb.get_pixel(717, 360).0[0] > 200);
    }

    #[test]
    fn square_jpeg_is_kept_and_big_art_is_scaled() {
        let small = encode(
            image::DynamicImage::ImageRgb8(image::RgbImage::new(544, 544)),
            image::ImageFormat::Jpeg,
        );
        assert_eq!(square_cover(&small).unwrap(), small);
        let big = encode(
            image::DynamicImage::ImageRgb8(image::RgbImage::new(1600, 1500)),
            image::ImageFormat::Png,
        );
        let out = image::load_from_memory(&square_cover(&big).unwrap()).unwrap();
        assert_eq!((out.width(), out.height()), (COVER_MAX, COVER_MAX));
        assert!(square_cover(b"not an image").is_err());
    }

    #[test]
    fn next_slot_follows_the_highest_number() {
        let dir = std::env::temp_dir().join(format!("rekord-slot-{}", uuid::Uuid::new_v4()));
        assert_eq!(next_track_slot(&dir), 1);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(next_track_slot(&dir), 1);
        for name in [
            "01 - A.m4a",
            "02 - B.opus",
            "07 - C.m4a",
            "cover.jpg",
            "99 - notes.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(next_track_slot(&dir), 8);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn print_arg_is_one_json_line() {
        let p = meta_print_arg();
        assert!(
            p.starts_with("after_move:[rekord-meta] %(.{id,title,"),
            "{p}"
        );
        assert!(p.ends_with(",thumbnails})j"), "{p}");
    }

    #[test]
    fn thumbnails_are_tried_best_first_from_known_hosts_only() {
        let meta = json!({
            "thumbnail": "https://i.ytimg.com/vi/x/maxresdefault.webp",
            "thumbnails": [
                {"url": "https://i.ytimg.com/vi/x/default.jpg"},
                {"url": "http://i.ytimg.com/vi/x/mq.jpg"},
                {"url": "https://127.0.0.1/evil.jpg"},
                {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"},
                {"url": "https://i.ytimg.com/vi/x/maxresdefault.webp"},
            ],
        });
        assert_eq!(
            thumbnail_urls(&meta),
            vec![
                "https://i.ytimg.com/vi/x/maxresdefault.webp".to_string(),
                "https://i.ytimg.com/vi/x/hqdefault.jpg".to_string(),
                "https://i.ytimg.com/vi/x/default.jpg".to_string(),
            ]
        );
        assert!(
            thumbnail_urls(&json!({"thumbnail": "https://evil.example/ytimg.com.jpg"})).is_empty()
        );
        assert_eq!(
            thumbnail_urls(&json!({"thumbnail": "https://f4.bcbits.com/img/a1_10.jpg"})).len(),
            1
        );
    }
}
