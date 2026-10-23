//! "Update yt-dlp": download the latest official release for this platform
//! from GitHub, verify it against the release's `SHA2-256SUMS`, and install it
//! atomically as `<data_dir>/tools/yt-dlp`. Tool resolution prefers that copy
//! whenever it is the newest one found (see [`crate::tools`]).
//!
//! `REKORD_YTDLP_RELEASE_API` overrides the release metadata URL (GitHub API
//! "latest release" JSON shape: `tag_name`, `assets[].name`,
//! `assets[].browser_download_url`).

use crate::tools::{self, Tool, ToolContext};
use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const DEFAULT_RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const SUMS_ASSET: &str = "SHA2-256SUMS";
/// The one-file builds are ~35 MB; refuse anything absurd.
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("an update is already running")]
    InProgress,
    #[error("no official yt-dlp build for this platform")]
    UnsupportedPlatform,
    #[error("release lookup failed: {0}")]
    ReleaseLookup(String),
    #[error("release has no {0} asset")]
    AssetMissing(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("checksum list has no entry for {0}")]
    ChecksumMissing(String),
    #[error("checksum mismatch for {0}")]
    ChecksumMismatch(String),
    #[error("install failed: {0}")]
    Install(String),
}

impl UpdateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InProgress => "ytdlp_update_in_progress",
            Self::UnsupportedPlatform => "ytdlp_platform_unsupported",
            Self::ReleaseLookup(_) => "ytdlp_release_lookup_failed",
            Self::AssetMissing(_) => "ytdlp_asset_missing",
            Self::Download(_) => "ytdlp_download_failed",
            Self::ChecksumMissing(_) => "ytdlp_checksum_missing",
            Self::ChecksumMismatch(_) => "ytdlp_checksum_mismatch",
            Self::Install(_) => "ytdlp_install_failed",
        }
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::InProgress => StatusCode::CONFLICT,
            Self::UnsupportedPlatform => StatusCode::NOT_IMPLEMENTED,
            Self::Install(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_GATEWAY,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    /// A new binary was installed.
    pub updated: bool,
    /// The installed / current version already matched the latest release.
    pub up_to_date: bool,
    pub latest_version: String,
    pub previous_version: Option<String>,
    /// Version of the yt-dlp the hub now uses.
    pub version: Option<String>,
    /// Where the chosen binary comes from (`app_data`, `bundled`, …).
    pub source: Option<&'static str>,
    pub asset: String,
}

/// Official release asset for this platform.
pub fn platform_asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        ("windows", "x86_64") => Some("yt-dlp.exe"),
        ("windows", "aarch64") => Some("yt-dlp_arm64.exe"),
        ("macos", _) => Some("yt-dlp_macos"),
        _ => None,
    }
}

/// Hex digest for `asset` in a `SHA2-256SUMS` file (`<hex>  <name>` lines).
pub fn checksum_for(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hex = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset && hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hex.to_ascii_lowercase())
    })
}

fn release_api_url() -> String {
    std::env::var("REKORD_YTDLP_RELEASE_API")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASE_API.to_string())
}

fn http_client() -> Result<reqwest::Client, UpdateError> {
    Ok(crate::net::client(
        "yt-dlp updater",
        Duration::from_secs(15),
        Duration::from_secs(300),
    ))
}

struct Release {
    tag: String,
    asset_url: String,
    sums_url: String,
}

async fn latest_release(client: &reqwest::Client, asset: &str) -> Result<Release, UpdateError> {
    let res = client
        .get(release_api_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| UpdateError::ReleaseLookup(e.to_string()))?;
    if !res.status().is_success() {
        return Err(UpdateError::ReleaseLookup(format!("HTTP {}", res.status())));
    }
    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| UpdateError::ReleaseLookup(e.to_string()))?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| UpdateError::ReleaseLookup("missing tag_name".into()))?
        .to_string();
    let url_of = |name: &str| -> Option<String> {
        json.get("assets")?.as_array()?.iter().find_map(|a| {
            (a.get("name")?.as_str()? == name)
                .then(|| a.get("browser_download_url")?.as_str().map(str::to_string))
                .flatten()
        })
    };
    let asset_url = url_of(asset).ok_or_else(|| UpdateError::AssetMissing(asset.to_string()))?;
    let sums_url =
        url_of(SUMS_ASSET).ok_or_else(|| UpdateError::AssetMissing(SUMS_ASSET.to_string()))?;
    Ok(Release {
        tag,
        asset_url,
        sums_url,
    })
}

/// Stream `url` into `dest`, returning the SHA-256 hex digest.
async fn download_to(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<String, UpdateError> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| UpdateError::Download(e.to_string()))?;
    if !res.status().is_success() {
        return Err(UpdateError::Download(format!("HTTP {}", res.status())));
    }
    if res.content_length().is_some_and(|n| n > MAX_ASSET_BYTES) {
        return Err(UpdateError::Download("asset too large".into()));
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| UpdateError::Install(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| UpdateError::Download(e.to_string()))?;
        total += chunk.len() as u64;
        if total > MAX_ASSET_BYTES {
            return Err(UpdateError::Download("asset too large".into()));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| UpdateError::Install(e.to_string()))?;
    }
    file.flush()
        .await
        .map_err(|e| UpdateError::Install(e.to_string()))?;
    file.sync_all()
        .await
        .map_err(|e| UpdateError::Install(e.to_string()))?;
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

fn make_executable(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn install_atomically(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) if cfg!(windows) && dest.exists() => {
            // Windows refuses to replace a file in use; move it aside first.
            let aside = dest.with_extension("old");
            let _ = std::fs::remove_file(&aside);
            std::fs::rename(dest, &aside).map_err(|_| e)?;
            std::fs::rename(tmp, dest)
        }
        Err(e) => Err(e),
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Install the latest yt-dlp into `<data_dir>/tools` unless the hub already
/// uses that version (`force` reinstalls anyway).
pub async fn update_ytdlp(ctx: &ToolContext, force: bool) -> Result<UpdateReport, UpdateError> {
    let data_dir = ctx
        .data_dir
        .clone()
        .ok_or_else(|| UpdateError::Install("data dir unknown".into()))?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(UpdateError::InProgress);
    }
    let _guard = RunningGuard;
    let asset = platform_asset_name().ok_or(UpdateError::UnsupportedPlatform)?;

    let current = tools::resolve(Tool::Ytdlp, ctx).await;
    let client = http_client()?;
    let release = latest_release(&client, asset).await?;

    if !force
        && current.available
        && tools::compare_versions(current.version.as_deref(), Some(&release.tag))
            != std::cmp::Ordering::Less
    {
        return Ok(UpdateReport {
            updated: false,
            up_to_date: true,
            latest_version: release.tag,
            previous_version: current.version.clone(),
            version: current.version,
            source: current.source,
            asset: asset.to_string(),
        });
    }

    let sums = client
        .get(&release.sums_url)
        .send()
        .await
        .map_err(|e| UpdateError::Download(e.to_string()))?;
    if !sums.status().is_success() {
        return Err(UpdateError::Download(format!(
            "{SUMS_ASSET}: HTTP {}",
            sums.status()
        )));
    }
    let sums = sums
        .text()
        .await
        .map_err(|e| UpdateError::Download(e.to_string()))?;
    let expected =
        checksum_for(&sums, asset).ok_or_else(|| UpdateError::ChecksumMissing(asset.into()))?;

    let dir = tools::tools_dir(&data_dir);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| UpdateError::Install(e.to_string()))?;
    let tmp: PathBuf = dir.join(format!(".yt-dlp-{}.part", uuid::Uuid::new_v4().simple()));
    let result = async {
        let actual = download_to(&client, &release.asset_url, &tmp).await?;
        if actual != expected {
            return Err(UpdateError::ChecksumMismatch(asset.to_string()));
        }
        make_executable(&tmp).map_err(|e| UpdateError::Install(e.to_string()))?;
        let probe_path = tmp.clone();
        let probed = tokio::task::spawn_blocking(move || {
            tools::probe_version_blocking(Tool::Ytdlp, &probe_path)
        })
        .await
        .ok()
        .flatten();
        if probed.is_none() {
            return Err(UpdateError::Install(
                "downloaded yt-dlp does not run on this machine".into(),
            ));
        }
        let dest = tools::app_data_ytdlp_path(&data_dir);
        install_atomically(&tmp, &dest).map_err(|e| UpdateError::Install(e.to_string()))?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result?;

    tools::invalidate(Tool::Ytdlp);
    let now = tools::resolve(Tool::Ytdlp, ctx).await;
    Ok(UpdateReport {
        updated: true,
        up_to_date: false,
        latest_version: release.tag,
        previous_version: current.version,
        version: now.version,
        source: now.source,
        asset: asset.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_checksum_lines() {
        let sums = "\
0000000000000000000000000000000000000000000000000000000000000000  yt-dlp
58162F9BFDC27458EA47BFCB311CF47028F17D8154A8BF7D689861D46399230A  yt-dlp_linux
1111111111111111111111111111111111111111111111111111111111111111 *yt-dlp.exe
";
        assert_eq!(
            checksum_for(sums, "yt-dlp_linux").as_deref(),
            Some("58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a")
        );
        assert!(checksum_for(sums, "yt-dlp.exe").is_some());
        assert!(checksum_for(sums, "yt-dlp_macos").is_none());
    }
}
