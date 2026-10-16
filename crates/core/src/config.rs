use crate::ytdlp_cookies::{is_netscape_cookies, CookieFormatError};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PersistedSettings {
    pub music_root: Option<PathBuf>,
    /// Absolute path to Netscape cookies file (when not locked by env).
    pub youtube_cookies_path: Option<PathBuf>,
    /// Absolute path to Discogs token file (when not locked by env).
    pub discogs_token_path: Option<PathBuf>,
    /// Optional override for yt-dlp binary.
    pub ytdlp_path: Option<PathBuf>,
    /// Watch the music root and re-index incrementally on changes.
    pub watch_library: Option<bool>,
    /// Allow host-level operations (library path, scan, credentials, tunnel) from
    /// non-loopback clients. Off by default: LAN/tunnel clients stay read-only there.
    pub allow_remote_admin: Option<bool>,
    /// Optional "Podcast e notizie" module (off unless enabled in the admin panel).
    /// Kept as raw JSON like `power`: a mistyped value must not void the
    /// whole file (music root included), only fall back to the defaults.
    pub podcasts: Option<serde_json::Value>,
    /// "Prevent the computer from sleeping" (`settings.json` → `power`). Kept as
    /// raw JSON and read leniently: a bad value must not void the other keys.
    pub power: Option<serde_json::Value>,
    /// "Leggi metadati e copertine incorporati" and its priority.
    pub embedded_metadata: Option<serde_json::Value>,
}

/// When the hub keeps the computer from going to sleep.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PreventSleep {
    /// Never (default): the hub does nothing.
    #[default]
    Off,
    /// For as long as the hub runs.
    Always,
    /// While the hub is in use, plus a grace period after the last activity.
    WhenActive,
}

impl PreventSleep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Always => "always",
            Self::WhenActive => "whenActive",
        }
    }

    /// Accepts the API spelling (`whenActive`) and the CLI one (`when-active`).
    pub fn parse(raw: &str) -> Option<Self> {
        let k: String = raw
            .trim()
            .chars()
            .filter(|c| !matches!(c, '-' | '_' | ' '))
            .flat_map(char::to_lowercase)
            .collect();
        match k.as_str() {
            "off" | "never" | "0" | "false" | "no" => Some(Self::Off),
            "always" | "on" | "1" | "true" | "yes" => Some(Self::Always),
            "whenactive" | "active" | "inuse" => Some(Self::WhenActive),
            _ => None,
        }
    }
}

/// Hub settings of "Prevent the computer from sleeping" (`settings.json` → `power`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PowerSettings {
    pub prevent_sleep: PreventSleep,
    /// `whenActive`: minutes the lock is kept after the last activity.
    pub grace_minutes: u32,
    /// Linux only: also block the suspend a closed laptop lid triggers.
    pub keep_awake_lid_closed: bool,
}

impl Default for PowerSettings {
    fn default() -> Self {
        Self {
            prevent_sleep: PreventSleep::Off,
            grace_minutes: Self::DEFAULT_GRACE_MINUTES,
            keep_awake_lid_closed: false,
        }
    }
}

impl PowerSettings {
    pub const DEFAULT_GRACE_MINUTES: u32 = 10;
    pub const MIN_GRACE_MINUTES: u32 = 1;
    pub const MAX_GRACE_MINUTES: u32 = 120;

    pub fn clamped(mut self) -> Self {
        self.grace_minutes = self
            .grace_minutes
            .clamp(Self::MIN_GRACE_MINUTES, Self::MAX_GRACE_MINUTES);
        self
    }

    /// Lenient read of `settings.json` → `power`: unknown or mistyped values
    /// fall back to their defaults one by one.
    pub fn from_json(v: &serde_json::Value) -> Self {
        let d = Self::default();
        Self {
            prevent_sleep: v
                .get("preventSleep")
                .and_then(|x| x.as_str())
                .and_then(PreventSleep::parse)
                .unwrap_or(d.prevent_sleep),
            grace_minutes: v
                .get("graceMinutes")
                .and_then(|x| x.as_u64())
                .map(|n| n.min(u32::MAX as u64) as u32)
                .unwrap_or(d.grace_minutes),
            keep_awake_lid_closed: v
                .get("keepAwakeLidClosed")
                .and_then(|x| x.as_bool())
                .unwrap_or(d.keep_awake_lid_closed),
        }
        .clamped()
    }
}

/// A settings section from its raw JSON; defaults when missing or mistyped.
fn lenient<T: serde::de::DeserializeOwned + Default>(v: Option<&serde_json::Value>) -> T {
    v.and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// Hub settings of the podcasts module (`settings.json` → `podcasts`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PodcastSettings {
    pub enabled: bool,
    /// How long a fetched source stays fresh before the next on-demand fetch.
    pub cache_ttl_minutes: u32,
}

impl Default for PodcastSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            cache_ttl_minutes: PodcastSettings::DEFAULT_TTL_MINUTES,
        }
    }
}

impl PodcastSettings {
    pub const DEFAULT_TTL_MINUTES: u32 = 30;
    pub const MIN_TTL_MINUTES: u32 = 5;
    pub const MAX_TTL_MINUTES: u32 = 24 * 60;

    pub fn clamped(mut self) -> Self {
        self.cache_ttl_minutes = self
            .cache_ttl_minutes
            .clamp(Self::MIN_TTL_MINUTES, Self::MAX_TTL_MINUTES);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub data_dir: PathBuf,
    pub music_root: Option<PathBuf>,
    pub bind: SocketAddr,
    pub modules_manifest: PathBuf,
    #[serde(skip)]
    pub youtube_cookies_path: Option<PathBuf>,
    #[serde(skip)]
    pub youtube_cookies_from_env: bool,
    #[serde(skip)]
    pub discogs_token: Option<String>,
    #[serde(skip)]
    pub discogs_token_from_env: bool,
    #[serde(skip)]
    pub ytdlp_path: Option<PathBuf>,
    /// Filesystem watcher on the music root (persisted).
    #[serde(default = "default_watch_library")]
    pub watch_library: bool,
    /// Host-level operations allowed from remote clients (persisted).
    #[serde(default)]
    pub allow_remote_admin: bool,
    /// Podcasts module settings (persisted).
    #[serde(default)]
    pub podcasts: PodcastSettings,
    /// Sleep prevention (persisted; the mode can be locked by `REKORD_PREVENT_SLEEP`).
    #[serde(skip)]
    pub power: PowerSettings,
    /// `power.prevent_sleep` comes from `REKORD_PREVENT_SLEEP` / `--prevent-sleep`.
    #[serde(skip)]
    pub power_mode_from_env: bool,
    /// Embedded tags and covers (persisted).
    #[serde(default)]
    pub embedded: crate::embedded::EmbeddedSettings,
}

fn default_watch_library() -> bool {
    true
}

impl AppConfig {
    pub fn default_data_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("RE-KORD")
    }

    pub fn resolve(data_dir: Option<PathBuf>, bind: SocketAddr, manifest: Option<PathBuf>) -> Self {
        let data_dir = data_dir.unwrap_or_else(Self::default_data_dir);
        let modules_manifest = manifest.unwrap_or_else(|| data_dir.join("modules.manifest.toml"));
        Self {
            data_dir,
            music_root: None,
            bind,
            modules_manifest,
            youtube_cookies_path: None,
            youtube_cookies_from_env: false,
            discogs_token: None,
            discogs_token_from_env: false,
            ytdlp_path: None,
            watch_library: true,
            allow_remote_admin: false,
            podcasts: PodcastSettings::default(),
            power: PowerSettings::default(),
            power_mode_from_env: false,
            embedded: crate::embedded::EmbeddedSettings::default(),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("rekord.db")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    /// Per-account library selection root (see `accounts::account_library_selection_path`).
    pub fn accounts_dir(&self) -> PathBuf {
        self.data_dir.join("accounts")
    }

    pub fn default_youtube_cookies_path(&self) -> PathBuf {
        self.data_dir.join("youtube-cookies.txt")
    }

    pub fn default_discogs_token_path(&self) -> PathBuf {
        self.data_dir.join("discogs-token")
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.data_dir).context("create data dir")?;
        Ok(())
    }

    fn read_persisted(&self) -> PersistedSettings {
        let path = self.settings_path();
        if !path.exists() {
            return PersistedSettings::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write_persisted(&self, settings: &PersistedSettings) -> Result<()> {
        let path = self.settings_path();
        // Keep keys other modules store in settings.json (e.g. tunnel login).
        let mut merged = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .filter(|v| v.is_object())
            .unwrap_or_else(|| serde_json::json!({}));
        if let (Some(obj), serde_json::Value::Object(ours)) =
            (merged.as_object_mut(), serde_json::to_value(settings)?)
        {
            for (k, v) in ours {
                obj.insert(k, v);
            }
        }
        // Atomic replace: a crash mid-write must not leave a truncated file.
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&merged)?)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn env_first(keys: &[&str]) -> Option<String> {
        for k in keys {
            if let Ok(v) = std::env::var(k) {
                let t = v.trim().to_string();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
        None
    }

    /// Load music_root + cookies + discogs + ytdlp from disk/env into this config.
    pub fn load_persisted_settings(&mut self) -> Result<()> {
        let file = self.read_persisted();
        if let Some(root) = file.music_root.clone() {
            self.music_root = Some(root);
        }

        if let Some(p) = Self::env_first(&[
            "REKORD_YTDLP_COOKIES",
            "KORD_YTDLP_COOKIES",
            "WPP_YTDLP_COOKIES",
        ]) {
            self.youtube_cookies_path = Some(PathBuf::from(p));
            self.youtube_cookies_from_env = true;
        } else if let Some(p) = file.youtube_cookies_path.clone() {
            self.youtube_cookies_path = Some(p);
            self.youtube_cookies_from_env = false;
        } else {
            let default = self.default_youtube_cookies_path();
            if default.is_file() {
                self.youtube_cookies_path = Some(default);
            }
            self.youtube_cookies_from_env = false;
        }

        if let Some(tok) = Self::env_first(&[
            "REKORD_DISCOGS_TOKEN",
            "KORD_DISCOGS_TOKEN",
            "WPP_DISCOGS_TOKEN",
        ]) {
            self.discogs_token = Some(tok);
            self.discogs_token_from_env = true;
        } else {
            self.discogs_token_from_env = false;
            let tok_path = file
                .discogs_token_path
                .clone()
                .unwrap_or_else(|| self.default_discogs_token_path());
            if tok_path.is_file() {
                if let Ok(raw) = fs::read_to_string(&tok_path) {
                    let t = raw.trim().to_string();
                    if !t.is_empty() {
                        self.discogs_token = Some(t);
                    }
                }
            }
        }

        if let Some(p) = Self::env_first(&["YTDLP_PATH"]) {
            self.ytdlp_path = Some(PathBuf::from(p));
        } else if let Some(p) = file.ytdlp_path.clone() {
            self.ytdlp_path = Some(p);
        }

        self.watch_library = match Self::env_first(&["REKORD_WATCH_LIBRARY"]) {
            Some(v) => !matches!(v.as_str(), "0" | "false" | "off"),
            None => file.watch_library.unwrap_or(true),
        };
        self.allow_remote_admin = match Self::env_first(&["REKORD_ALLOW_REMOTE_ADMIN"]) {
            Some(v) => matches!(v.as_str(), "1" | "true" | "on"),
            None => file.allow_remote_admin.unwrap_or(false),
        };
        self.podcasts = lenient::<PodcastSettings>(file.podcasts.as_ref()).clamped();
        self.embedded = lenient(file.embedded_metadata.as_ref());
        self.load_power_settings(&file);

        Ok(())
    }

    /// `power` from the file, then the mode from `REKORD_PREVENT_SLEEP`
    /// (which `--prevent-sleep` sets), which locks it.
    fn load_power_settings(&mut self, file: &PersistedSettings) {
        self.power = file
            .power
            .as_ref()
            .map(PowerSettings::from_json)
            .unwrap_or_default();
        self.power_mode_from_env = false;
        if let Some(raw) = Self::env_first(&["REKORD_PREVENT_SLEEP"]) {
            match PreventSleep::parse(&raw) {
                Some(mode) => {
                    self.power.prevent_sleep = mode;
                    self.power_mode_from_env = true;
                }
                None => tracing::warn!(
                    value = %raw,
                    "REKORD_PREVENT_SLEEP ignored: use off, always or when-active"
                ),
            }
        }
    }

    /// Re-read `power` from `settings.json` (after a backup restore wrote it).
    pub fn reload_power_settings(&mut self) {
        let file = self.read_persisted();
        self.load_power_settings(&file);
    }

    /// Persist the power settings. A mode locked by the environment is not
    /// written: the file keeps its own.
    pub fn save_power_settings(&mut self, settings: PowerSettings) -> Result<()> {
        let settings = settings.clamped();
        let mut s = self.read_persisted();
        let mut stored = settings;
        if self.power_mode_from_env {
            stored.prevent_sleep = s
                .power
                .as_ref()
                .map(PowerSettings::from_json)
                .unwrap_or_default()
                .prevent_sleep;
        }
        s.power = Some(serde_json::to_value(stored)?);
        self.write_persisted(&s)?;
        self.power = settings;
        Ok(())
    }

    pub fn save_watch_library(&mut self, enabled: bool) -> Result<()> {
        self.watch_library = enabled;
        let mut s = self.read_persisted();
        s.watch_library = Some(enabled);
        self.write_persisted(&s)
    }

    pub fn save_allow_remote_admin(&mut self, enabled: bool) -> Result<()> {
        self.allow_remote_admin = enabled;
        let mut s = self.read_persisted();
        s.allow_remote_admin = Some(enabled);
        self.write_persisted(&s)
    }

    pub fn save_embedded_settings(
        &mut self,
        settings: crate::embedded::EmbeddedSettings,
    ) -> Result<()> {
        self.embedded = settings;
        let mut s = self.read_persisted();
        s.embedded_metadata = Some(serde_json::to_value(settings)?);
        self.write_persisted(&s)
    }

    pub fn save_podcast_settings(&mut self, settings: PodcastSettings) -> Result<()> {
        let settings = settings.clamped();
        self.podcasts = settings;
        let mut s = self.read_persisted();
        s.podcasts = Some(serde_json::to_value(settings)?);
        self.write_persisted(&s)
    }

    pub fn load_persisted_music_root(&mut self) -> Result<()> {
        self.load_persisted_settings()
    }

    pub fn save_music_root(&mut self, root: PathBuf) -> Result<()> {
        self.music_root = Some(root.clone());
        let mut s = self.read_persisted();
        s.music_root = Some(root);
        self.write_persisted(&s)
    }

    pub fn set_music_root_if_present(&mut self, root: Option<&Path>) -> Result<()> {
        if let Some(r) = root {
            self.save_music_root(r.to_path_buf())?;
        } else {
            self.load_persisted_settings()?;
        }
        Ok(())
    }

    pub fn youtube_cookies_for_ytdlp(&self) -> Option<PathBuf> {
        let p = self.youtube_cookies_path.as_ref()?;
        if p.is_file() && is_netscape_cookies(p) {
            Some(p.clone())
        } else {
            None
        }
    }

    pub fn set_youtube_cookies_bytes(&mut self, bytes: &[u8]) -> Result<PathBuf> {
        if self.youtube_cookies_from_env {
            anyhow::bail!("youtube cookies locked by environment");
        }
        // Validate before writing: a bad upload must not replace good cookies.
        let text = std::str::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!(CookieFormatError::NotNetscape.message()))?;
        crate::ytdlp_cookies::check_cookie_text(text).map_err(|e| anyhow::anyhow!(e.message()))?;
        let dest = self.default_youtube_cookies_path();
        // Credentials: owner-only (0600), replaced atomically.
        crate::ytdlp_cookies::store_upload(&dest, bytes)?;
        self.youtube_cookies_path = Some(dest.clone());
        let mut s = self.read_persisted();
        s.youtube_cookies_path = Some(dest.clone());
        self.write_persisted(&s)?;
        Ok(dest)
    }

    pub fn clear_youtube_cookies(&mut self) -> Result<()> {
        if self.youtube_cookies_from_env {
            anyhow::bail!("youtube cookies locked by environment");
        }
        if let Some(p) = self.youtube_cookies_path.take() {
            if p == self.default_youtube_cookies_path() {
                crate::ytdlp_cookies::remove_stored(&p);
            }
        }
        let default = self.default_youtube_cookies_path();
        crate::ytdlp_cookies::remove_stored(&default);
        let mut s = self.read_persisted();
        s.youtube_cookies_path = None;
        self.write_persisted(&s)
    }

    pub fn set_discogs_token(&mut self, token: &str) -> Result<()> {
        if self.discogs_token_from_env {
            anyhow::bail!("discogs token locked by environment");
        }
        let t = token.trim();
        if t.is_empty() {
            anyhow::bail!("empty token");
        }
        let dest = self.default_discogs_token_path();
        fs::write(&dest, t)?;
        self.discogs_token = Some(t.to_string());
        let mut s = self.read_persisted();
        s.discogs_token_path = Some(dest);
        self.write_persisted(&s)
    }

    pub fn clear_discogs_token(&mut self) -> Result<()> {
        if self.discogs_token_from_env {
            anyhow::bail!("discogs token locked by environment");
        }
        self.discogs_token = None;
        let dest = self.default_discogs_token_path();
        let _ = fs::remove_file(&dest);
        let mut s = self.read_persisted();
        s.discogs_token_path = None;
        self.write_persisted(&s)
    }

    pub fn ytdlp_enabled(&self) -> bool {
        !matches!(std::env::var("ENABLE_YTDLP"), Ok(v) if v.trim() == "0")
    }

    pub fn config_snapshot(&self) -> serde_json::Value {
        let cookie_status =
            crate::ytdlp_cookies::cookie_status(self.youtube_cookies_path.as_deref());
        let cookies_configured = cookie_status.valid;
        let cookies_label = self
            .youtube_cookies_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        serde_json::json!({
            "musicRoot": self.music_root.as_ref().map(|p| p.to_string_lossy()),
            "dataDir": self.data_dir.to_string_lossy(),
            "ytdlpEnabled": self.ytdlp_enabled(),
            "youtubeCookiesConfigured": cookies_configured,
            "youtubeCookiesLockedByEnv": self.youtube_cookies_from_env,
            "youtubeCookiesLabel": cookies_label,
            "youtubeCookiesWritable": !self.youtube_cookies_from_env,
            "youtubeCookiesPresent": cookie_status.present,
            "youtubeCookiesValid": cookie_status.valid,
            "youtubeCookiesEntries": cookie_status.entries,
            "youtubeCookiesYoutubeEntries": cookie_status.youtube_entries,
            "youtubeCookiesUpdatedAt": cookie_status.updated_at,
            "discogsConfigured": true,
            "discogsTokenConfigured": self.discogs_token.is_some(),
            "discogsLockedByEnv": self.discogs_token_from_env,
            "discogsWritable": !self.discogs_token_from_env,
            "watchLibrary": self.watch_library,
            "allowRemoteAdmin": self.allow_remote_admin,
        })
    }
}

#[cfg(test)]
mod lenient_tests {
    use super::*;

    #[test]
    fn a_mistyped_section_does_not_void_the_settings_file() {
        let dir = std::env::temp_dir().join(format!("rekord-cfg-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut cfg = AppConfig::resolve(Some(dir.clone()), "127.0.0.1:0".parse().unwrap(), None);
        fs::write(
            cfg.settings_path(),
            r#"{"music_root":"/music","embedded_metadata":{"enabled":"true","priority":"tags"},
               "podcasts":{"enabled":"yes"}}"#,
        )
        .unwrap();
        cfg.load_persisted_settings().unwrap();
        assert_eq!(cfg.music_root, Some(PathBuf::from("/music")));
        assert_eq!(cfg.embedded, crate::embedded::EmbeddedSettings::default());
        assert!(!cfg.podcasts.enabled);
        // Saving one section keeps the others.
        cfg.save_podcast_settings(PodcastSettings {
            enabled: true,
            ..cfg.podcasts
        })
        .unwrap();
        let mut again = AppConfig::resolve(Some(dir.clone()), "127.0.0.1:0".parse().unwrap(), None);
        again.load_persisted_settings().unwrap();
        assert_eq!(again.music_root, Some(PathBuf::from("/music")));
        assert!(again.podcasts.enabled);
        let _ = fs::remove_dir_all(&dir);
    }
}
