//! Cover thumbnails (parity `server/artwork/thumbs.mjs`).
//!
//! Grids and mobile clients ask for 128/256 px variants instead of full-size
//! artwork; variants are cached under `<data_dir>/thumbs/<size>/`.

use crate::state::AppState;
use anyhow::{Context, Result};
use image::imageops::FilterType;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::{info, warn};

/// Sizes the API is allowed to serve.
pub const ALLOWED_SIZES: &[u32] = &[128, 256];

pub fn normalize_size(requested: Option<u32>) -> Option<u32> {
    let size = requested?;
    if size == 0 {
        return None;
    }
    // Snap to the nearest supported bucket so clients can pass CSS pixels.
    ALLOWED_SIZES
        .iter()
        .copied()
        .find(|s| size <= *s)
        .or(Some(*ALLOWED_SIZES.last().unwrap()))
}

fn cache_dir(data_dir: &Path, size: u32) -> PathBuf {
    data_dir.join("thumbs").join(size.to_string())
}

fn cache_key(source: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    if let Ok(meta) = std::fs::metadata(source) {
        meta.len().hash(&mut hasher);
        if let Ok(modified) = meta.modified() {
            if let Ok(d) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                d.as_secs().hash(&mut hasher);
            }
        }
    }
    format!("{:016x}", hasher.finish())
}

pub fn cached_path(data_dir: &Path, source: &Path, size: u32) -> PathBuf {
    cache_dir(data_dir, size).join(format!("{}.jpg", cache_key(source)))
}

/// Return a cached thumbnail, generating it on first use.
pub fn ensure_thumb(data_dir: &Path, source: &Path, size: u32) -> Result<PathBuf> {
    let dest = cached_path(data_dir, source, size);
    if dest.is_file() {
        return Ok(dest);
    }
    generate(source, &dest, size)?;
    Ok(dest)
}

fn generate(source: &Path, dest: &Path, size: u32) -> Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let img = image::open(source).with_context(|| format!("decode {}", source.display()))?;
    let thumb = img.resize(size, size, FilterType::Triangle);
    // JPEG keeps the cache small; covers never need alpha.
    let rgb = thumb.to_rgb8();
    let tmp = dest.with_extension("jpg.tmp");
    rgb.save_with_format(&tmp, image::ImageFormat::Jpeg)
        .with_context(|| format!("encode {}", tmp.display()))?;
    std::fs::rename(&tmp, dest).with_context(|| format!("rename into {}", dest.display()))?;
    Ok(())
}

/// Pre-generate thumbnails for every known album cover, as a cancelable job.
pub fn spawn_backfill(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        // Let the initial scan settle first: covers are discovered there.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        while state.is_scanning() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if let Err(err) = run_backfill(state).await {
            warn!(error = %err, "thumbnail backfill failed");
        }
    });
}

pub async fn run_backfill(state: AppState) -> Result<()> {
    let data_dir = state.config.lock().unwrap().data_dir.clone();
    let covers = state.db.all_album_cover_paths()?;
    if covers.is_empty() {
        return Ok(());
    }
    let job = state.jobs.start("thumbs", "Miniature copertine", true);
    let total = covers.len();
    let handle = tokio::task::spawn_blocking(move || {
        let mut made = 0u64;
        for (index, path) in covers.into_iter().enumerate() {
            if job.is_canceled() {
                job.finish(format!("annullato dopo {made} miniature"));
                return made;
            }
            if !path.is_file() {
                continue;
            }
            for size in ALLOWED_SIZES {
                match ensure_thumb(&data_dir, &path, *size) {
                    Ok(_) => made += 1,
                    Err(err) => {
                        warn!(path = %path.display(), size, error = %err, "thumb generation failed");
                    }
                }
            }
            if index % 25 == 0 {
                job.progress(
                    (index as f32 + 1.0) / total as f32,
                    format!("{}/{total} copertine", index + 1),
                );
            }
        }
        job.finish(format!("{made} miniature pronte"));
        made
    })
    .await;
    match handle {
        Ok(made) => {
            if made > 0 {
                info!(thumbs = made, "cover thumbnails ready");
            }
            Ok(())
        }
        Err(err) => Err(anyhow::anyhow!(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_snap_to_supported_buckets() {
        assert_eq!(normalize_size(None), None);
        assert_eq!(normalize_size(Some(0)), None);
        assert_eq!(normalize_size(Some(64)), Some(128));
        assert_eq!(normalize_size(Some(128)), Some(128));
        assert_eq!(normalize_size(Some(200)), Some(256));
        assert_eq!(normalize_size(Some(4000)), Some(256));
    }

    #[test]
    fn cache_paths_are_per_size_and_stable() {
        let data = PathBuf::from("/tmp/rekord-data");
        let src = PathBuf::from("/music/Artist/Album/cover.jpg");
        let a = cached_path(&data, &src, 128);
        let b = cached_path(&data, &src, 256);
        assert_ne!(a, b);
        assert_eq!(a, cached_path(&data, &src, 128));
        assert!(a.starts_with(data.join("thumbs").join("128")));
    }
}
