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
        fs::write(path, serde_json::to_string_pretty(settings)?)?;
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

        Ok(())
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
        let dest = self.default_youtube_cookies_path();
        fs::write(&dest, bytes)?;
        if !is_netscape_cookies(&dest) {
            let _ = fs::remove_file(&dest);
            anyhow::bail!("file is not a Netscape cookies.txt");
        }
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
                let _ = fs::remove_file(&p);
            }
        }
        let default = self.default_youtube_cookies_path();
        let _ = fs::remove_file(&default);
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
        match std::env::var("ENABLE_YTDLP") {
            Ok(v) if v.trim() == "0" => false,
            _ => true,
        }
    }

    pub fn config_snapshot(&self) -> serde_json::Value {
        let cookies_configured = self.youtube_cookies_for_ytdlp().is_some();
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
            "discogsConfigured": true,
            "discogsTokenConfigured": self.discogs_token.is_some(),
            "discogsLockedByEnv": self.discogs_token_from_env,
            "discogsWritable": !self.discogs_token_from_env,
        })
    }
}

fn is_netscape_cookies(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let head = raw.lines().take(40).collect::<Vec<_>>().join("\n");
    head.contains("# Netscape HTTP Cookie File")
        || head.contains("# HTTP Cookie File")
        || raw.lines().any(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#') && t.split('\t').count() >= 6
        })
}
