//! yt-dlp invocation for Studio downloads: tool chain, arguments, per-item
//! summary of the output stream, and the process runner.

use crate::config::AppConfig;
use crate::path_util::{rel_path_looks_like_album_folder, safe_rel_path};
use crate::tools::{self, Tool, ToolContext};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use url::Url;

/// Rolling stdout/stderr kept in memory (bytes, char-boundary safe).
pub const ROLL_CAP: usize = 64 * 1024;
/// stdout/stderr preview size in the `done` event.
pub const DONE_FIELD_MAX: usize = 12 * 1024;

/// Audio-only formats, best first. No trailing `/best`: a muxed video format
/// (YouTube itag 18) is never an acceptable result; when nothing audio-only
/// exists the item fails with `no_audio_format`.
pub const AUDIO_FORMAT: &str = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio";

/// Marker printed by `--print pre_process:…` for every item (id, playlist
/// index, title), before format selection, so failures can be attributed.
pub const ITEM_MARKER: &str = "[rekord-item]";

const ALLOWED_HOSTS: &[&str] = &[
    "youtube.com",
    "music.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "bandcamp.com",
];

/// Legacy-compatible `{ label, reason }` entry (skipped / failed items).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFail {
    pub label: String,
    pub reason: String,
}

/// Resolved programs for one download.
#[derive(Debug, Clone, Default)]
pub struct Toolchain {
    pub ytdlp: PathBuf,
    pub ffmpeg: Option<PathBuf>,
    /// `--js-runtimes` value (`quickjs:/abs/qjs`, `node:/abs/node`, …).
    pub js_runtime: Option<String>,
}

impl Toolchain {
    /// Resolve yt-dlp / ffmpeg (cached, off the async workers) and the JS runtime.
    pub async fn resolve(cfg: &AppConfig) -> Self {
        let ctx = ToolContext::from_config(cfg);
        let (ytdlp, ffmpeg, js) = tokio::join!(
            tools::resolve(Tool::Ytdlp, &ctx),
            tools::resolve(Tool::Ffmpeg, &ctx),
            crate::js_runtime::resolve()
        );
        Self {
            ytdlp: ytdlp.path,
            ffmpeg: ffmpeg.available.then_some(ffmpeg.path),
            js_runtime: js.runtime.map(|r| r.arg()),
        }
    }
}

/// yt-dlp program to run (resolved, cached).
pub async fn ytdlp_program(cfg: &AppConfig) -> PathBuf {
    tools::resolve(Tool::Ytdlp, &ToolContext::from_config(cfg))
        .await
        .path
}

/// `--js-runtimes` value (`quickjs:/abs/qjs`, `node:/abs/node`, …) from the
/// cached lookup, see [`crate::js_runtime`]. `None` when no runtime is usable
/// (the flag is then omitted; a bare `node:node` would fail).
pub fn js_runtime_arg() -> Option<String> {
    crate::js_runtime::quick().map(|rt| rt.arg())
}

/// `--js-runtimes` (when a runtime exists) and `--remote-components`.
pub fn javascript_args_for(js_runtime: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(rt) = js_runtime {
        args.push("--js-runtimes".into());
        args.push(rt.to_string());
    }
    if let Ok(remote) = std::env::var("REKORD_YTDLP_REMOTE_COMPONENTS") {
        let t = remote.trim();
        if !t.is_empty() {
            args.push("--remote-components".into());
            args.push(t.to_string());
        }
    }
    args
}

/// JS arguments without waiting (cached or filesystem-only lookup).
pub(crate) fn javascript_args() -> Vec<String> {
    javascript_args_for(js_runtime_arg().as_deref())
}

/// JS arguments from a probed lookup (off the async workers, cached).
pub(crate) async fn javascript_args_resolved() -> Vec<String> {
    let rt = crate::js_runtime::resolve().await.runtime;
    javascript_args_for(rt.map(|r| r.arg()).as_deref())
}

pub fn ytdlp_enabled() -> bool {
    !matches!(std::env::var("ENABLE_YTDLP"), Ok(v) if v.trim() == "0")
}

pub fn normalize_http_url(raw: &str) -> String {
    let s = raw.trim();
    if s.starts_with("//") {
        return format!("https:{s}");
    }
    s.to_string()
}

pub fn coerce_ytdlp_url(raw: &str) -> String {
    let s = normalize_http_url(raw);
    if s.is_empty() {
        return s;
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return s;
    }
    if s.starts_with('/') {
        return format!("https://www.youtube.com{s}");
    }
    if s.starts_with("watch?")
        || s.starts_with("playlist?")
        || s.starts_with("embed/")
        || s.starts_with("shorts/")
    {
        return format!("https://www.youtube.com/{s}");
    }
    s
}

pub fn is_allowed_ytdlp_url(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else {
        return false;
    };
    if u.scheme() != "http" && u.scheme() != "https" {
        return false;
    }
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if ALLOWED_HOSTS.iter().any(|h| host == *h) {
        return true;
    }
    ALLOWED_HOSTS
        .iter()
        .any(|h| host.ends_with(&format!(".{h}")))
}

pub fn is_uuid_download_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value.trim()).is_ok()
}

fn is_probably_playlist_url(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else {
        return false;
    };
    if let Some(list) = u.query_pairs().find(|(k, _)| k == "list").map(|(_, v)| v) {
        if !list.is_empty() && list.to_ascii_uppercase() != "WL" {
            return true;
        }
    }
    u.path().contains("/playlist")
}

fn track_index_fragment(url: &str) -> &'static str {
    if is_probably_playlist_url(url) {
        "%(playlist_index)02d"
    } else {
        "%(autonumber)02d"
    }
}

fn flat_tracks_dest_kind(kind: &str) -> bool {
    matches!(
        kind,
        "download_single" | "download_playlist" | "download_ytmusic" | "download_releases"
    )
}

pub fn output_template(url: &str, download_kind: &str, output_dir: &str) -> String {
    let name = "%(track,title)s";
    if flat_tracks_dest_kind(download_kind) && rel_path_looks_like_album_folder(output_dir) {
        return format!("{} - {name}.%(ext)s", track_index_fragment(url));
    }
    let n = track_index_fragment(url);
    if let Ok(u) = Url::parse(url) {
        let host = u
            .host_str()
            .unwrap_or("")
            .trim_start_matches("www.")
            .to_ascii_lowercase();
        if host.ends_with("bandcamp.com") {
            return format!("%(album)s/{n} - {name}.%(ext)s");
        }
        let pl = is_probably_playlist_url(url);
        if host.contains("music.youtube.com") {
            if pl {
                return format!("%(album|playlist_title)s/{n} - {name}.%(ext)s");
            }
            return format!("%(album)s/{n} - {name}.%(ext)s");
        }
        if pl {
            return format!("%(playlist_title)s/{n} - {name}.%(ext)s");
        }
    }
    format!("%(title)s/{n} - {name}.%(ext)s")
}

pub fn build_download_args(
    toolchain: &Toolchain,
    url: &str,
    download_kind: &str,
    output_dir: &str,
    cookies: Option<&Path>,
) -> Result<Vec<String>> {
    let out_dir = safe_rel_path(output_dir)?;
    let mut tmpl = output_template(url, download_kind, &out_dir);
    if !out_dir.is_empty() {
        tmpl = format!(
            "{}/{}",
            out_dir.trim_end_matches('/'),
            tmpl.trim_start_matches('/')
        );
    }
    let mut args: Vec<String> = vec!["-f".into(), AUDIO_FORMAT.into()];
    if let Some(ffmpeg) = &toolchain.ffmpeg {
        args.push("--ffmpeg-location".into());
        args.push(ffmpeg.to_string_lossy().into_owned());
    }
    args.extend(javascript_args_for(toolchain.js_runtime.as_deref()));
    // A per-run copy (`ytdlp_cookies::YtdlpCookies`), never the stored file.
    if let Some(cookies) = cookies {
        args.push("--cookies".into());
        args.push(cookies.to_string_lossy().into_owned());
    }
    // One progress line per update (pipes), and an id/title marker per item
    // printed before format selection; `--print` implies quiet/simulate, so
    // both are turned back off explicitly.
    args.extend(
        [
            "--newline",
            "--no-quiet",
            "--no-simulate",
            "--print",
            &format!("pre_process:{ITEM_MARKER} %(id)s\t%(playlist_index|)s\t%(title)s"),
        ]
        .map(String::from),
    );
    args.push("-o".into());
    args.push(tmpl);
    if download_kind == "download_single" {
        args.push("--no-playlist".into());
    }
    args.push(url.to_string());
    Ok(args)
}

/// Command line for logs and the `done` event: no absolute paths (program,
/// ffmpeg, cookies, JS runtime are reduced to names), URL omitted.
pub fn display_command(program: &Path, args: &[String]) -> String {
    let name = program
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "yt-dlp".into());
    let mut out = vec![name];
    let mut prev = "";
    for a in args.iter().take(args.len().saturating_sub(1)) {
        let shown = match prev {
            "--cookies" => "<cookies>".to_string(),
            "--ffmpeg-location" => Path::new(a)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "ffmpeg".into()),
            "--js-runtimes" => a.split(':').next().unwrap_or("node").to_string(),
            _ => a.clone(),
        };
        out.push(if shown.contains(' ') || shown.contains('\t') {
            format!("\"{}\"", shown.replace('\t', "\\t"))
        } else {
            shown
        });
        prev = a.as_str();
    }
    out.push("…".into());
    out.join(" ")
}

/// Largest index `<= i` that is a char boundary of `s`.
pub fn floor_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut i = i;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest index `>= i` that is a char boundary of `s`.
pub fn ceil_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut i = i;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// At most `max` bytes from the start of `s`, cut on a char boundary.
pub fn head_bytes(s: &str, max: usize) -> &str {
    &s[..floor_char_boundary(s, max)]
}

/// At most `max` bytes from the end of `s`, cut on a char boundary.
pub fn tail_bytes(s: &str, max: usize) -> &str {
    &s[ceil_char_boundary(s, s.len().saturating_sub(max))..]
}

/// Rolling capped log (stdout or stderr of one download).
#[derive(Debug, Default)]
pub struct RollLog {
    buffer: String,
    total_bytes: usize,
}

impl RollLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, chunk: &str) {
        self.total_bytes += chunk.len();
        self.buffer.push_str(chunk);
        if self.buffer.len() > ROLL_CAP {
            self.buffer = tail_bytes(&self.buffer, ROLL_CAP).to_string();
        }
    }

    /// Preview for the `done` event: head + tail when too long.
    /// Returns (text, truncated, total bytes seen).
    pub fn trim_for_done(&self) -> (String, bool, usize) {
        let s = &self.buffer;
        let truncated = self.total_bytes > DONE_FIELD_MAX;
        if s.len() <= DONE_FIELD_MAX {
            return (s.clone(), truncated, self.total_bytes);
        }
        let half = DONE_FIELD_MAX / 2 - 48;
        (
            format!(
                "{}\n… [truncated stdout/stderr preview] …\n{}",
                head_bytes(s, half),
                tail_bytes(s, half)
            ),
            true,
            self.total_bytes,
        )
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for x in chars.by_ref() {
                    if x.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

pub fn extract_last_item_progress(text: &str) -> Option<(u32, u32)> {
    let clean = strip_ansi(text);
    let mut last = None;
    let needle = "Downloading item ";
    for line in clean.lines() {
        if let Some(idx) = line.find(needle) {
            let rest = &line[idx + needle.len()..];
            let mut parts = rest.split_whitespace();
            let cur = parts.next()?.parse::<u32>().ok()?;
            if parts.next()?.eq_ignore_ascii_case("of") {
                let total = parts.next()?.parse::<u32>().ok()?;
                last = Some((cur, total));
            }
        }
    }
    last
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Pending,
    Downloaded,
    Skipped,
    Failed,
}

/// One playlist entry / video as seen in the yt-dlp output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecord {
    pub id: Option<String>,
    pub index: Option<u32>,
    pub title: Option<String>,
    pub status: ItemStatus,
    /// Format id(s) yt-dlp chose (`140`, `251`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    /// Files written (paths relative to the music root).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl ItemRecord {
    fn new(id: Option<String>, index: Option<u32>) -> Self {
        Self {
            id,
            index,
            title: None,
            status: ItemStatus::Pending,
            format: None,
            reason: None,
            code: None,
            files: Vec::new(),
        }
    }

    /// Human label: title, else id, else "item N".
    pub fn label(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.id.clone())
            .or_else(|| self.index.map(|i| format!("item {i}")))
            .unwrap_or_else(|| "unknown item".into())
    }
}

/// Failed item in the `done` summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedItem {
    pub id: Option<String>,
    pub index: Option<u32>,
    pub title: Option<String>,
    /// Legacy field: title / id / "item N".
    pub label: String,
    pub reason: String,
    pub code: &'static str,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSummary {
    pub downloaded: usize,
    pub skipped: usize,
    pub failed: usize,
    /// Playlist size when yt-dlp announced it ("Downloading item N of M").
    pub total: Option<u32>,
    pub downloaded_items: Vec<String>,
    pub skipped_items: Vec<ItemFail>,
    pub failed_items: Vec<FailedItem>,
    pub items: Vec<ItemRecord>,
    /// Format ids yt-dlp chose, deduplicated.
    pub formats: Vec<String>,
}

/// Map a yt-dlp error message to a stable code.
pub fn classify_ytdlp_error(message: &str) -> &'static str {
    let m = message.to_ascii_lowercase();
    if m.contains("requested format is not available") || m.contains("no video formats found") {
        "no_audio_format"
    } else if m.contains("private video") {
        "private_video"
    } else if m.contains("confirm your age")
        || m.contains("age-restricted")
        || m.contains("age restricted")
    {
        "age_restricted"
    } else if m.contains("members-only") || m.contains("join this channel") {
        "members_only"
    } else if m.contains("not available in your country")
        || m.contains("geo restrict")
        || m.contains("geo-restrict")
    {
        "geo_blocked"
    } else if m.contains("sign in to confirm")
        || m.contains("sign in")
        || m.contains("--cookies")
        // YouTube's bot gate when the player challenge was not solved (no JS
        // runtime for yt-dlp, or cookies without one).
        || m.contains("page needs to be reloaded")
    {
        "sign_in_required"
    } else if m.contains("unavailable")
        || m.contains("this video is not available")
        || m.contains("has been removed")
        || m.contains("does not exist")
    {
        "video_unavailable"
    } else if m.contains("http error 403")
        || m.contains("403: forbidden")
        || m.contains("403 forbidden")
    {
        "http_forbidden"
    } else if m.contains("postprocessing") || m.contains("ffmpeg") || m.contains("ffprobe") {
        "postprocess_failed"
    } else if m.contains("timed out")
        || m.contains("unable to download")
        || m.contains("connection")
        || m.contains("getaddrinfo")
        || m.contains("network")
    {
        "network_error"
    } else {
        "unknown"
    }
}

/// Tags of `[tag] <id>: …` lines that carry a media id (extractor lines and
/// `[info]`). Playlist extractors (`youtube:tab`) contain ':' and are skipped.
fn id_from_tagged_line(line: &str) -> Option<(&str, &str, &str)> {
    let rest = line.strip_prefix('[')?;
    let close = rest.find(']')?;
    let tag = &rest[..close];
    if tag.is_empty() || tag.contains(':') || tag.contains(' ') {
        return None;
    }
    let lower = tag.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "download"
            | "merger"
            | "extractaudio"
            | "metadata"
            | "movefiles"
            | "debug"
            | "ffmpeg"
            | "hlsnative"
            | "dashsegments"
            | "rekord-item"
    ) || lower.starts_with("fixup")
    {
        return None;
    }
    let after = rest[close + 1..].trim_start();
    let colon = after.find(": ")?;
    let id = &after[..colon];
    if id.is_empty() || id.contains(char::is_whitespace) || id.len() > 64 {
        return None;
    }
    Some((tag, id, after[colon + 2..].trim()))
}

fn title_from_file(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    // "07 - Title" → "Title"
    let trimmed = stem.trim_start_matches(|c: char| c.is_ascii_digit());
    match trimmed.strip_prefix(" - ") {
        Some(t) if trimmed.len() != stem.len() && !t.trim().is_empty() => t.trim().to_string(),
        _ => stem.to_string(),
    }
}

/// Event produced while following the output.
#[derive(Debug, Clone, PartialEq)]
pub enum TrackerEvent {
    Progress(u32, u32),
    /// Index into `ItemTracker::items` whose status changed.
    Item(usize),
}

/// Follows the full yt-dlp output (both pipes, every line) and attributes
/// downloads / skips / errors to the item they belong to.
#[derive(Debug, Default)]
pub struct ItemTracker {
    items: Vec<ItemRecord>,
    by_id: HashMap<String, usize>,
    current: Option<usize>,
    pending_index: Option<u32>,
    progress: Option<(u32, u32)>,
    unattributed: Vec<FailedItem>,
}

impl ItemTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn progress(&self) -> Option<(u32, u32)> {
        self.progress
    }

    pub fn item(&self, i: usize) -> Option<&ItemRecord> {
        self.items.get(i)
    }

    fn by_id_or_new(&mut self, id: &str) -> usize {
        if let Some(&i) = self.by_id.get(id) {
            return i;
        }
        let i = self.items.len();
        self.items
            .push(ItemRecord::new(Some(id.to_string()), self.pending_index));
        self.by_id.insert(id.to_string(), i);
        i
    }

    fn current_or_new(&mut self) -> usize {
        if let Some(i) = self.current {
            return i;
        }
        let i = self.items.len();
        self.items.push(ItemRecord::new(None, self.pending_index));
        self.current = Some(i);
        i
    }

    /// Feed one output line (ANSI already stripped or not).
    pub fn feed_line(&mut self, raw: &str) -> Vec<TrackerEvent> {
        let clean = strip_ansi(raw);
        let line = clean.trim();
        let mut events = Vec::new();
        if line.is_empty() {
            return events;
        }
        if let Some(rest) = line.strip_prefix("[download] Downloading item ") {
            let mut parts = rest.split_whitespace();
            if let (Some(cur), Some(of), Some(total)) = (parts.next(), parts.next(), parts.next()) {
                if of.eq_ignore_ascii_case("of") {
                    if let (Ok(c), Ok(t)) = (cur.parse::<u32>(), total.parse::<u32>()) {
                        self.progress = Some((c, t));
                        self.pending_index = Some(c);
                        self.current = None;
                        events.push(TrackerEvent::Progress(c, t));
                    }
                }
            }
            return events;
        }
        if let Some(rest) = line.strip_prefix(ITEM_MARKER) {
            let mut parts = rest.trim_start().splitn(3, '\t');
            let id = parts.next().unwrap_or("").trim();
            let idx = parts.next().unwrap_or("").trim().parse::<u32>().ok();
            let title = parts.next().unwrap_or("").trim();
            if !id.is_empty() && id != "NA" {
                let i = self.by_id_or_new(id);
                let rec = &mut self.items[i];
                if let Some(n) = idx.or(self.pending_index) {
                    rec.index = Some(n);
                }
                if !title.is_empty() && title != "NA" {
                    rec.title = Some(title.to_string());
                }
                self.current = Some(i);
            }
            return events;
        }
        if let Some(rest) = line.strip_prefix("ERROR:") {
            let msg = rest.trim();
            let (target, reason) = match id_from_tagged_line(msg) {
                Some((_, id, m)) => (Some(self.by_id_or_new(id)), m.to_string()),
                None => (self.current, msg.to_string()),
            };
            let code = classify_ytdlp_error(&reason);
            match target {
                Some(i) => {
                    let rec = &mut self.items[i];
                    rec.status = ItemStatus::Failed;
                    rec.reason = Some(reason);
                    rec.code = Some(code);
                    events.push(TrackerEvent::Item(i));
                }
                None => self.unattributed.push(FailedItem {
                    id: None,
                    index: self.pending_index,
                    title: None,
                    label: "unknown item".into(),
                    reason,
                    code,
                }),
            }
            return events;
        }
        if let Some(rest) = line.strip_prefix("[download] Destination:") {
            let path = rest.trim().to_string();
            if path.is_empty() {
                return events;
            }
            let i = self.current_or_new();
            let rec = &mut self.items[i];
            if rec.title.is_none() {
                rec.title = Some(title_from_file(&path));
            }
            if !rec.files.contains(&path) {
                rec.files.push(path);
            }
            if rec.status == ItemStatus::Pending {
                rec.status = ItemStatus::Downloaded;
                events.push(TrackerEvent::Item(i));
            }
            return events;
        }
        if let Some(rest) = line.strip_prefix("[download] ") {
            if let Some(path) = rest.strip_suffix(" has already been downloaded") {
                let path = path.trim().to_string();
                let i = self.current_or_new();
                let rec = &mut self.items[i];
                if rec.title.is_none() {
                    rec.title = Some(title_from_file(&path));
                }
                if rec.status != ItemStatus::Failed {
                    rec.status = ItemStatus::Skipped;
                    rec.reason = Some("already downloaded".into());
                    rec.code = Some("already_downloaded");
                    events.push(TrackerEvent::Item(i));
                }
                return events;
            }
            return events;
        }
        if let Some((tag, id, msg)) = id_from_tagged_line(line) {
            let i = self.by_id_or_new(id);
            self.current = Some(i);
            if tag.eq_ignore_ascii_case("info") {
                // "[info] <id>: Downloading 1 format(s): 140"
                if let Some(pos) = msg.find("format(s):") {
                    let f = msg[pos + "format(s):".len()..].trim();
                    if !f.is_empty() {
                        self.items[i].format = Some(f.to_string());
                    }
                }
            }
        }
        events
    }

    /// Final per-item summary.
    pub fn summary(&self) -> DownloadSummary {
        let mut s = DownloadSummary {
            total: self.progress.map(|(_, t)| t),
            ..Default::default()
        };
        for rec in &self.items {
            match rec.status {
                ItemStatus::Downloaded => {
                    s.downloaded += 1;
                    s.downloaded_items.extend(rec.files.iter().cloned());
                }
                ItemStatus::Skipped => {
                    s.skipped += 1;
                    s.skipped_items.push(ItemFail {
                        label: rec.label(),
                        reason: rec.reason.clone().unwrap_or_default(),
                    });
                }
                ItemStatus::Failed => {
                    s.failed += 1;
                    s.failed_items.push(FailedItem {
                        id: rec.id.clone(),
                        index: rec.index,
                        title: rec.title.clone(),
                        label: rec.label(),
                        reason: rec.reason.clone().unwrap_or_default(),
                        code: rec.code.unwrap_or("unknown"),
                    });
                }
                ItemStatus::Pending => {}
            }
            if let Some(f) = &rec.format {
                if !s.formats.contains(f) {
                    s.formats.push(f.clone());
                }
            }
        }
        s.failed += self.unattributed.len();
        s.failed_items.extend(self.unattributed.iter().cloned());
        s.items = self.items.clone();
        s
    }
}

/// Summary of a complete log (tests, legacy callers). Lines of both pipes are
/// fed in order: stdout first, then stderr.
pub fn summary_from_log(stdout: &str, stderr: &str) -> DownloadSummary {
    let mut t = ItemTracker::new();
    for line in stdout.lines().chain(stderr.lines()) {
        t.feed_line(line);
    }
    t.summary()
}

/// yt-dlp per-update progress line (`[download]  42.0% of …`): noise in logs.
pub fn is_progress_noise(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix("[download]") else {
        return false;
    };
    let rest = rest.trim_start();
    rest.split_whitespace()
        .next()
        .is_some_and(|tok| tok.ends_with('%') && tok[..tok.len() - 1].parse::<f64>().is_ok())
}

/// Error of a `-J` probe (flat count, releases, enrich).
#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("yt-dlp not found")]
    NotFound,
    #[error("yt-dlp timed out")]
    Timeout,
    #[error("{0}")]
    Failed(String),
}

impl ProbeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "ytdlp_not_found",
            Self::Timeout => "ytdlp_timeout",
            Self::Failed(m) => match classify_ytdlp_error(m) {
                "unknown" => "ytdlp_failed",
                c => c,
            },
        }
    }
}

pub async fn run_json_probe(cfg: &AppConfig, url: &str, timeout_ms: u64) -> Result<Value> {
    let program = ytdlp_program(cfg).await;
    let mut args = vec![
        "-J".into(),
        "--flat-playlist".into(),
        "--no-download".into(),
        "--no-warnings".into(),
    ];
    args.extend(javascript_args_resolved().await);
    // Held until the probe is over; the copy is removed on drop.
    let cookies = crate::ytdlp_cookies::YtdlpCookies::prepare(cfg);
    if let Some(jar) = &cookies {
        args.extend(jar.args());
    }
    args.push(url.to_string());
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::child_group::isolate(&mut cmd);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ProbeError::NotFound.into())
        }
        Err(e) => return Err(ProbeError::Failed(e.to_string()).into()),
    };
    // A timeout or a dropped request kills yt-dlp itself, not just its launcher.
    let mut group = crate::child_group::GroupKill::new(&child);
    let output = match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => {
            group.disarm();
            o
        }
        Ok(Err(e)) => return Err(ProbeError::Failed(e.to_string()).into()),
        Err(_) => return Err(ProbeError::Timeout.into()),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_ytdlp_json(&stdout) {
        Ok(v) => Ok(v),
        Err(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr
                .lines()
                .rev()
                .find(|l| l.trim_start().starts_with("ERROR:"))
                .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
                .unwrap_or("invalid yt-dlp JSON")
                .trim()
                .to_string();
            Err(ProbeError::Failed(detail).into())
        }
    }
}

/// Events sent while a download runs (JSON objects, one NDJSON line each).
pub type EventTx = mpsc::Sender<Value>;

/// Longest log line forwarded in `log` events.
const LOG_LINE_MAX: usize = 2000;

/// Result of one yt-dlp run (before the library refresh).
#[derive(Debug, Clone)]
pub struct DownloadOutcome {
    pub exit_code: i32,
    pub cancelled: bool,
    /// `ytdlp_not_found` / `ytdlp_spawn_failed` when the process never ran.
    pub spawn_error: Option<&'static str>,
    pub summary: DownloadSummary,
    pub progress: Option<(u32, u32)>,
    pub stdout: String,
    pub stderr: String,
    pub log_truncated: bool,
    pub stdout_total: usize,
    pub stderr_total: usize,
    pub command: String,
}

impl DownloadOutcome {
    /// Something usable came out (files written or already present), or a
    /// clean exit with no failure. Playlist counters advance even when every
    /// format selection fails, so a bare exit code is not enough.
    pub fn succeeded(&self) -> bool {
        if self.cancelled || self.spawn_error.is_some() {
            return false;
        }
        let s = &self.summary;
        s.downloaded > 0 || s.skipped > 0 || (self.exit_code == 0 && s.failed == 0)
    }

    /// Stable error code when the job did not succeed.
    pub fn error_code(&self) -> Option<&'static str> {
        if self.succeeded() {
            return None;
        }
        if let Some(e) = self.spawn_error {
            return Some(e);
        }
        if self.cancelled {
            return Some("cancelled");
        }
        let fails = &self.summary.failed_items;
        if !fails.is_empty()
            && fails.iter().all(|f| f.code == fails[0].code)
            && fails[0].code != "unknown"
        {
            return Some(fails[0].code);
        }
        Some("ytdlp_failed")
    }
}

/// Ask a child process to stop (SIGTERM to its process group on Unix so
/// yt-dlp can clean up its `.part` files; `taskkill /T` on Windows to include
/// ffmpeg children).
async fn terminate_pid(pid: u32) {
    #[cfg(unix)]
    {
        // The whole group: the PyInstaller launcher, yt-dlp and its ffmpeg.
        crate::child_group::signal_group(pid, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
}

fn item_event(tracker: &ItemTracker, i: usize) -> Option<Value> {
    let rec = tracker.item(i)?;
    Some(json!({ "type": "item", "item": rec }))
}

/// Run yt-dlp for one Studio download, streaming `progress` / `item` / `log`
/// / `keepalive` events. The caller sends `started` and `done`.
#[allow(clippy::too_many_arguments)]
pub async fn run_download(
    cfg: &AppConfig,
    toolchain: &Toolchain,
    music_root: &Path,
    url: &str,
    download_kind: &str,
    output_dir: &str,
    cancel: Arc<AtomicBool>,
    events: EventTx,
) -> Result<DownloadOutcome> {
    let program = toolchain.ytdlp.clone();
    // Private copy for this run (yt-dlp rewrites the jar on exit); removed
    // when this function returns, i.e. after the process has exited.
    let cookies = crate::ytdlp_cookies::YtdlpCookies::prepare(cfg);
    let args = build_download_args(
        toolchain,
        url,
        download_kind,
        output_dir,
        cookies.as_ref().map(|c| c.path()),
    )?;
    let command = display_command(&program, &args);

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(music_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("FORCE_COLOR", "0")
        .env("PYTHONIOENCODING", "utf-8");
    crate::child_group::isolate(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, program = %program.display(), "yt-dlp spawn failed");
            return Ok(DownloadOutcome {
                exit_code: -1,
                cancelled: cancel.load(Ordering::SeqCst),
                spawn_error: Some(if e.kind() == std::io::ErrorKind::NotFound {
                    "ytdlp_not_found"
                } else {
                    "ytdlp_spawn_failed"
                }),
                summary: DownloadSummary::default(),
                progress: None,
                stdout: String::new(),
                stderr: e.to_string(),
                log_truncated: false,
                stdout_total: 0,
                stderr_total: 0,
                command,
            });
        }
    };
    let child_pid = child.id();
    // Hub shutdown (the task is dropped) stops yt-dlp, not just its launcher.
    let mut group = crate::child_group::GroupKill::new(&child);
    let stdout = child.stdout.take().context("stdout")?;
    let stderr = child.stderr.take().context("stderr")?;

    let (log_tx, mut log_rx) = mpsc::channel::<(bool, String)>(256);
    let log_tx_o = log_tx.clone();
    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    if log_tx_o.send((true, line)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let log_tx_e = log_tx;
    let err_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    if log_tx_e.send((false, line)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Cancel watcher kills by PID so it doesn't fight child.wait() borrow.
    // It ends with the child (`exited`), so finished downloads leave no task.
    let cancel_watch = cancel.clone();
    let exited = Arc::new(AtomicBool::new(false));
    let exited_watch = exited.clone();
    tokio::spawn(async move {
        while !cancel_watch.load(Ordering::SeqCst) {
            if exited_watch.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        if let Some(pid) = child_pid {
            if !exited_watch.load(Ordering::SeqCst) {
                terminate_pid(pid).await;
            }
        }
    });

    let mut out_log = RollLog::new();
    let mut err_log = RollLog::new();
    let mut tracker = ItemTracker::new();
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive.tick().await;
    let mut exit_code: Option<i32> = None;
    let mut logs_open = true;

    let mut handle_line = |is_out: bool, line: String, tracker: &mut ItemTracker| -> Vec<Value> {
        let mut out = Vec::new();
        let marker = line.trim_start().starts_with(ITEM_MARKER);
        if marker {
            // Our own id/title marker: tracked, not shown.
        } else if is_out {
            out_log.append(&line);
            out_log.append("\n");
        } else {
            err_log.append(&line);
            err_log.append("\n");
        }
        for ev in tracker.feed_line(&line) {
            match ev {
                TrackerEvent::Progress(c, t) => out.push(json!({
                    "type": "progress",
                    "progress": { "current": c, "total": t },
                })),
                TrackerEvent::Item(i) => {
                    if let Some(v) = item_event(tracker, i) {
                        out.push(v);
                    }
                }
            }
        }
        if !marker && !is_progress_noise(&line) && !line.trim().is_empty() {
            out.push(json!({
                "type": "log",
                "stream": if is_out { "stdout" } else { "stderr" },
                "line": head_bytes(&line, LOG_LINE_MAX),
            }));
        }
        out
    };

    while exit_code.is_none() {
        tokio::select! {
            status = child.wait() => {
                exited.store(true, Ordering::SeqCst);
                group.disarm();
                exit_code = Some(status.ok().and_then(|s| s.code()).unwrap_or(-1));
            }
            _ = keepalive.tick() => {
                let _ = events.send(json!({ "type": "keepalive" })).await;
            }
            chunk = log_rx.recv(), if logs_open => {
                match chunk {
                    Some((is_out, line)) => {
                        for ev in handle_line(is_out, line, &mut tracker) {
                            let _ = events.send(ev).await;
                        }
                    }
                    None => logs_open = false,
                }
            }
        }
    }
    // Drain what the readers still hold (pipes close right after exit).
    let drain_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    if logs_open {
        while let Ok(Some((is_out, line))) =
            tokio::time::timeout_at(drain_deadline, log_rx.recv()).await
        {
            for ev in handle_line(is_out, line, &mut tracker) {
                let _ = events.send(ev).await;
            }
        }
    }
    out_task.abort();
    err_task.abort();

    // Keep the cookies yt-dlp refreshed, only after a clean run.
    if exit_code == Some(0) && !cancel.load(Ordering::SeqCst) {
        if let Some(jar) = &cookies {
            jar.write_back();
        }
    }
    drop(cookies);

    let (stdout_text, trunc_o, stdout_total) = out_log.trim_for_done();
    let (stderr_text, trunc_e, stderr_total) = err_log.trim_for_done();
    Ok(DownloadOutcome {
        exit_code: exit_code.unwrap_or(-1),
        cancelled: cancel.load(Ordering::SeqCst),
        spawn_error: None,
        progress: tracker.progress(),
        summary: tracker.summary(),
        stdout: stdout_text,
        stderr: stderr_text,
        log_truncated: trunc_o || trunc_e,
        stdout_total,
        stderr_total,
        command,
    })
}

pub fn parse_ytdlp_json(stdout: &str) -> Result<Value> {
    let t = stdout.trim();
    if t.is_empty() {
        bail!("empty yt-dlp JSON");
    }
    // yt-dlp may emit multiple JSON objects; take the largest/last object-looking chunk.
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Ok(v);
    }
    if let Some(start) = t.find('{') {
        if let Some(end) = t.rfind('}') {
            if end > start {
                return Ok(serde_json::from_str(&t[start..=end])?);
            }
        }
    }
    bail!("invalid yt-dlp JSON")
}

pub fn playlist_track_count(data: &Value) -> Option<u64> {
    if data.get("_type").and_then(|v| v.as_str()) == Some("video") {
        return Some(1);
    }
    if let Some(n) = data.get("playlist_count").and_then(|v| v.as_u64()) {
        return Some(n);
    }
    data.get("entries")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u64)
}

pub fn guess_youtube_url_from_entry_id(id: &str) -> String {
    let s = id.trim();
    if s.len() == 11
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return format!("https://www.youtube.com/watch?v={s}");
    }
    if s.starts_with("PL")
        || s.starts_with("OLAK5uy_")
        || s.starts_with("UU")
        || s.starts_with("FL")
        || s.starts_with("RD")
        || s.starts_with("WL")
        || s.starts_with("LL")
        || s.starts_with("LM")
    {
        return format!("https://www.youtube.com/playlist?list={s}");
    }
    String::new()
}

pub fn pick_flat_entry_url(e: &Value) -> String {
    for key in ["url", "webpage_url", "original_url"] {
        if let Some(s) = e.get(key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return coerce_ytdlp_url(t);
            }
        }
    }
    String::new()
}

/// Ensure cwd exists.
pub fn ensure_music_root(root: &Path) -> Result<()> {
    if !root.is_dir() {
        bail!("music_root missing");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn char_boundary_slicing_never_panics() {
        let s = "àèìòù日本語".repeat(5000);
        for max in [0, 1, 2, 3, 7, 1000, 12 * 1024, 64 * 1024, s.len() + 10] {
            let h = head_bytes(&s, max);
            let t = tail_bytes(&s, max);
            assert!(h.len() <= max && t.len() <= max);
        }
        let mut log = RollLog::new();
        for _ in 0..3000 {
            log.append("[download] 東京事変 – Café Ünïcödé — ");
        }
        let (text, truncated, total) = log.trim_for_done();
        assert!(truncated);
        assert!(total > ROLL_CAP);
        assert!(text.len() <= DONE_FIELD_MAX);
    }

    #[test]
    fn tagged_line_ids() {
        assert_eq!(
            id_from_tagged_line("[youtube] dQw4w9WgXcQ: Downloading webpage").map(|t| t.1),
            Some("dQw4w9WgXcQ")
        );
        assert!(id_from_tagged_line("[youtube] Extracting URL: https://x").is_none());
        assert!(id_from_tagged_line("[youtube:tab] PL123: Downloading page").is_none());
        assert!(id_from_tagged_line("[download] Destination: a/b.m4a").is_none());
    }

    #[test]
    fn progress_noise() {
        assert!(is_progress_noise(
            "[download]  42.0% of 3.20MiB at 1.00MiB/s ETA 00:02"
        ));
        assert!(is_progress_noise(
            "[download] 100% of    3.20MiB in 00:00:01"
        ));
        assert!(!is_progress_noise("[download] Destination: x.m4a"));
    }

    #[test]
    fn titles_from_files() {
        assert_eq!(title_from_file("A/B/07 - Hello World.m4a"), "Hello World");
        assert_eq!(title_from_file("A/B/Hello.m4a"), "Hello");
    }

    #[test]
    fn error_codes() {
        assert_eq!(
            classify_ytdlp_error("Requested format is not available. Use --list-formats"),
            "no_audio_format"
        );
        assert_eq!(
            classify_ytdlp_error("Video unavailable"),
            "video_unavailable"
        );
        assert_eq!(
            classify_ytdlp_error("Private video. Sign in"),
            "private_video"
        );
        assert_eq!(
            classify_ytdlp_error("unable to download video data: HTTP Error 403: Forbidden"),
            "http_forbidden"
        );
        assert_eq!(
            classify_ytdlp_error("ERROR: [youtube] jNQXAC9IVRw: The page needs to be reloaded."),
            "sign_in_required"
        );
        assert_eq!(
            classify_ytdlp_error(
                "ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies-from-browser"
            ),
            "sign_in_required"
        );
    }
}
