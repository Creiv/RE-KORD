//! Embedded metadata and covers (5.1): what audio files say about
//! themselves, read on the first scan of a file and again when it changes.
//!
//! Precedence, per field: a value a person typed in Studio always wins;
//! with the default priority ([`EmbeddedPriority::Studio`]) every curated
//! value (Studio, sidecar, metadata fetch, legacy library) wins over the
//! tags, the tags over the file / folder name. With
//! [`EmbeddedPriority::Embedded`] the tags also replace curated values nobody
//! typed. Covers, first found wins: the folder image (where Studio saves),
//! the legacy `.kord/artwork`, the embedded picture. Online covers are only
//! fetched on request, and saved as folder images.
//!
//! - [`tags`]: one read per file (tags, picture, duration);
//! - [`cover`]: the hub's store of embedded covers;
//! - [`backfill`]: the background job that reads the tags of files indexed
//!   before 5.1 (or again after a "re-read" or a settings change).

pub mod backfill;
pub mod cover;
pub mod tags;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Version of the tag reader. Tracks read by an older one (`tags_version`)
/// are picked up by the backfill job.
pub const TAGS_VERSION: i64 = 1;

/// Which source fills a field first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbeddedPriority {
    /// Studio > embedded > file name (default).
    #[default]
    Studio,
    /// Embedded > Studio > file name, for values nobody typed.
    Embedded,
}

impl EmbeddedPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Embedded => "embedded",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "studio" => Some(Self::Studio),
            "embedded" | "tags" => Some(Self::Embedded),
            _ => None,
        }
    }
}

/// Hub settings (`settings.json` → `embedded_metadata`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EmbeddedSettings {
    /// "Leggi metadati e copertine incorporati".
    pub enabled: bool,
    pub priority: EmbeddedPriority,
    /// "Incorpora tag e copertina nei file scaricati": Studio downloads get
    /// tags and the cover written into them ([`crate::download_tags`]).
    pub embed_downloads: bool,
}

impl Default for EmbeddedSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            priority: EmbeddedPriority::Studio,
            embed_downloads: true,
        }
    }
}

/// How a scan (or the backfill) treats embedded tags and pictures.
#[derive(Debug, Clone)]
pub struct EmbeddedOptions {
    pub enabled: bool,
    pub priority: EmbeddedPriority,
    /// Where embedded covers are stored; `None`: covers are not extracted.
    pub cover_store: Option<PathBuf>,
}

impl Default for EmbeddedOptions {
    /// Tags on, Studio first, no cover store (library-only callers).
    fn default() -> Self {
        Self {
            enabled: true,
            priority: EmbeddedPriority::Studio,
            cover_store: None,
        }
    }
}

impl EmbeddedOptions {
    pub fn new(settings: EmbeddedSettings, data_dir: &std::path::Path) -> Self {
        Self {
            enabled: settings.enabled,
            priority: settings.priority,
            cover_store: Some(cover::store_dir(data_dir)),
        }
    }

    pub fn from_config(cfg: &crate::config::AppConfig) -> Self {
        Self::new(cfg.embedded, &cfg.data_dir)
    }

    /// Embedded covers are extracted and used.
    pub fn covers(&self) -> Option<&std::path::Path> {
        self.cover_store.as_deref().filter(|_| self.enabled)
    }

    pub fn merge_policy(&self) -> MergePolicy {
        MergePolicy {
            prefer_embedded: self.enabled && self.priority == EmbeddedPriority::Embedded,
            override_user: false,
        }
    }
}

/// How a fresh read of a file meets the values already stored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergePolicy {
    /// Tag values replace curated values nobody typed.
    pub prefer_embedded: bool,
    /// Tag values replace everything, typed values too (the admin's explicit
    /// "re-read embedded tags" with the embedded priority).
    pub override_user: bool,
}
