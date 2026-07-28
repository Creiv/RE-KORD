//! Path safety helpers for music_root-relative operations.

use anyhow::{bail, Result};
use std::path::{Component, Path, PathBuf};

/// Normalize and validate a relative path under music root (no `..`, absolute, etc.).
pub fn safe_rel_path(raw: &str) -> Result<String> {
    let s = raw.replace('\\', "/").trim().trim_matches('/').to_string();
    if s.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for seg in s.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains('\0') {
            bail!("invalid relative path");
        }
        parts.push(seg);
    }
    Ok(parts.join("/"))
}

pub fn safe_dir_name(raw: &str) -> Result<String> {
    let s = raw.trim();
    if s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..") || s.contains('\0')
    {
        bail!("invalid directory name");
    }
    Ok(s.to_string())
}

pub fn join_under_root(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = safe_rel_path(rel)?;
    let path = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(PathBuf::from(&rel))
    };
    // Reject absolute components sneaked in via weird paths.
    for c in path.components() {
        if matches!(c, Component::ParentDir) {
            bail!("invalid path");
        }
    }
    Ok(path)
}

pub fn under_root(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(&r),
        _ => {
            // Fallback when path does not exist yet (mkdir).
            let p = path.to_path_buf();
            let r = root.to_path_buf();
            p.starts_with(&r)
        }
    }
}

pub fn rel_path_looks_like_album_folder(rel: &str) -> bool {
    safe_rel_path(rel)
        .map(|s| s.split('/').filter(|p| !p.is_empty()).count() >= 2)
        .unwrap_or(false)
}
