//! Library layout config + structure probe (parity `server/libraryLayout.mjs`).
//!
//! The layout descriptor lives in `<music_root>/.kord/library-layout.json` so it
//! travels with the library, exactly like the legacy version.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const LAYOUT_SCHEMA_VERSION: u32 = 1;
pub const LOOSE_ALBUM_FOLDER: &str = "Tracks";

const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "aiff", "aif", "alac", "webm",
];

const LAYOUT_EXCLUDE: &[&str] = &[
    ".rekord",
    ".kord",
    "kord",
    ".wpp",
    "@eaDir",
    "#recycle",
    ".Trash",
    ".trash",
    "node_modules",
    ".git",
];

/// Detected / configured folder organisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PreferredLayout {
    /// `<root>/<artist>/<album>/<track>` — RE-KORD default.
    #[serde(rename = "artist/album/track")]
    ArtistAlbumTrack,
    /// `<root>/<artist>/<track>` — no album level.
    #[serde(rename = "artist/track")]
    ArtistTrack,
    /// Audio files directly in the root.
    #[serde(rename = "flat")]
    Flat,
    /// Trust ID3 tags over folder names.
    #[serde(rename = "tags")]
    Tags,
}

impl PreferredLayout {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArtistAlbumTrack => "artist/album/track",
            Self::ArtistTrack => "artist/track",
            Self::Flat => "flat",
            Self::Tags => "tags",
        }
    }
}

impl Default for PreferredLayout {
    fn default() -> Self {
        Self::ArtistAlbumTrack
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLayout {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub preferred_layout: PreferredLayout,
    #[serde(default = "default_fallbacks")]
    pub fallbacks: Vec<String>,
    #[serde(default = "default_virtual_artist")]
    pub virtual_artist: String,
    #[serde(default = "default_virtual_album")]
    pub virtual_album: String,
    /// When true the scanner walks arbitrary depth instead of exactly two levels.
    #[serde(default)]
    pub deep_scan: bool,
}

fn default_schema_version() -> u32 {
    LAYOUT_SCHEMA_VERSION
}

fn default_fallbacks() -> Vec<String> {
    vec!["folder".into(), "tags".into(), "filename".into()]
}

fn default_virtual_artist() -> String {
    "Varie".into()
}

fn default_virtual_album() -> String {
    "Sconosciuto".into()
}

impl Default for LibraryLayout {
    fn default() -> Self {
        Self {
            schema_version: LAYOUT_SCHEMA_VERSION,
            preferred_layout: PreferredLayout::default(),
            fallbacks: default_fallbacks(),
            virtual_artist: default_virtual_artist(),
            virtual_album: default_virtual_album(),
            deep_scan: false,
        }
    }
}

impl LibraryLayout {
    pub fn uses_tags(&self) -> bool {
        self.preferred_layout == PreferredLayout::Tags || self.fallbacks.iter().any(|f| f == "tags")
    }
}

pub fn layout_path(music_root: &Path) -> PathBuf {
    music_root.join(".kord").join("library-layout.json")
}

pub fn load_layout(music_root: &Path) -> LibraryLayout {
    let path = layout_path(music_root);
    let Ok(raw) = fs::read_to_string(&path) else {
        return LibraryLayout::default();
    };
    serde_json::from_str::<LibraryLayout>(&raw).unwrap_or_default()
}

pub fn save_layout(music_root: &Path, layout: &LibraryLayout) -> Result<()> {
    let path = layout_path(music_root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let mut out = layout.clone();
    out.schema_version = LAYOUT_SCHEMA_VERSION;
    let body = serde_json::to_string_pretty(&out)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes()).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStats {
    pub audio_at_root: u64,
    pub dirs_at_root: u64,
    pub dirs_with_only_audio: u64,
    pub dirs_with_subdirs: u64,
    pub max_depth: u32,
    pub estimated_tracks: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCandidate {
    pub layout: String,
    pub confidence: f32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub stats: ProbeStats,
    pub candidates: Vec<LayoutCandidate>,
    pub warnings: Vec<String>,
    pub suggested_layout: LibraryLayout,
    pub current_layout: LibraryLayout,
}

pub fn is_audio_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => AUDIO_EXT.contains(&ext),
        None => false,
    }
}

pub fn is_excluded_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || LAYOUT_EXCLUDE
            .iter()
            .any(|d| d.eq_ignore_ascii_case(&lower))
}

fn count_audio_in_dir(dir: &Path, limit: u64) -> u64 {
    let mut count = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        if count >= limit {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(is_audio_name)
        {
            count += 1;
        }
    }
    count
}

/// Analyse the folder tree without persisting anything (setup helper).
pub fn probe_structure(music_root: &Path, sample_limit: u64) -> ProbeReport {
    let sample_limit = sample_limit.clamp(20, 5_000);
    let mut stats = ProbeStats::default();
    let mut warnings = Vec::new();
    let current_layout = load_layout(music_root);

    let entries = match fs::read_dir(music_root) {
        Ok(e) => e,
        Err(err) => {
            return ProbeReport {
                stats,
                candidates: vec![LayoutCandidate {
                    layout: PreferredLayout::ArtistAlbumTrack.as_str().into(),
                    confidence: 0.5,
                    reason: "Layout predefinito RE-KORD".into(),
                }],
                warnings: vec![err.to_string()],
                suggested_layout: LibraryLayout::default(),
                current_layout,
            };
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        if path.is_file() {
            if is_audio_name(name) {
                stats.audio_at_root += 1;
                stats.estimated_tracks += 1;
            }
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        stats.dirs_at_root += 1;

        let mut sub_dirs: Vec<PathBuf> = Vec::new();
        let mut audio_in_dir = 0u64;
        if let Ok(subs) = fs::read_dir(&path) {
            for sub in subs.flatten() {
                let sub_path = sub.path();
                let Some(sub_name) = sub_path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if sub_path.is_dir() {
                    if !is_excluded_dir(sub_name) {
                        sub_dirs.push(sub_path);
                    }
                } else if sub_path.is_file() && is_audio_name(sub_name) {
                    audio_in_dir += 1;
                }
            }
        }

        if !sub_dirs.is_empty() {
            stats.dirs_with_subdirs += 1;
            stats.max_depth = stats.max_depth.max(2);
            for sub in sub_dirs.iter().take(5) {
                stats.estimated_tracks += count_audio_in_dir(sub, sample_limit);
            }
        }
        if audio_in_dir > 0 {
            if sub_dirs.is_empty() {
                stats.dirs_with_only_audio += 1;
                stats.max_depth = stats.max_depth.max(1);
            }
            stats.estimated_tracks += audio_in_dir;
        }
        if stats.estimated_tracks >= sample_limit * 10 {
            break;
        }
    }

    let mut candidates = Vec::new();
    if stats.dirs_at_root > 0 && stats.dirs_with_subdirs >= stats.dirs_with_only_audio {
        candidates.push(LayoutCandidate {
            layout: PreferredLayout::ArtistAlbumTrack.as_str().into(),
            confidence: 0.85,
            reason: "Cartelle con sottocartelle che contengono audio".into(),
        });
    }
    if stats.dirs_with_only_audio > 0 {
        candidates.push(LayoutCandidate {
            layout: PreferredLayout::ArtistTrack.as_str().into(),
            confidence: 0.7,
            reason: "Cartelle con file audio senza sottolivello album".into(),
        });
    }
    if stats.audio_at_root > 0 {
        candidates.push(LayoutCandidate {
            layout: PreferredLayout::Flat.as_str().into(),
            confidence: 0.65,
            reason: "File audio direttamente nella radice".into(),
        });
    }
    if candidates.is_empty() {
        candidates.push(LayoutCandidate {
            layout: PreferredLayout::ArtistAlbumTrack.as_str().into(),
            confidence: 0.5,
            reason: "Layout predefinito RE-KORD".into(),
        });
    }
    candidates.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));

    if music_root.join(".kord").is_dir() {
        warnings.push("Cartella .kord presente: i dati esistenti sono preservati".into());
    }
    if stats.dirs_at_root == 0 && stats.audio_at_root == 0 {
        warnings.push("Nessun contenuto audio trovato nella radice".into());
    }

    let suggested = match candidates.first().map(|c| c.layout.as_str()) {
        Some("artist/track") => PreferredLayout::ArtistTrack,
        Some("flat") => PreferredLayout::Flat,
        Some("tags") => PreferredLayout::Tags,
        _ => PreferredLayout::ArtistAlbumTrack,
    };
    let suggested_layout = LibraryLayout {
        preferred_layout: suggested,
        deep_scan: stats.max_depth > 2,
        ..LibraryLayout::default()
    };

    ProbeReport {
        stats,
        candidates,
        warnings,
        suggested_layout,
        current_layout,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_names_are_detected_case_insensitively() {
        assert!(is_audio_name("a.MP3"));
        assert!(is_audio_name("track.flac"));
        assert!(!is_audio_name("cover.jpg"));
        assert!(!is_audio_name("noext"));
    }

    #[test]
    fn dot_dirs_and_known_junk_are_excluded() {
        assert!(is_excluded_dir(".kord"));
        assert!(is_excluded_dir("node_modules"));
        assert!(is_excluded_dir("@eaDir"));
        assert!(!is_excluded_dir("Caparezza"));
    }

    #[test]
    fn layout_roundtrips_through_json() {
        let layout = LibraryLayout {
            preferred_layout: PreferredLayout::ArtistTrack,
            deep_scan: true,
            ..LibraryLayout::default()
        };
        let raw = serde_json::to_string(&layout).unwrap();
        let back: LibraryLayout = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.preferred_layout, PreferredLayout::ArtistTrack);
        assert!(back.deep_scan);
        assert!(raw.contains("artist/track"));
    }
}
