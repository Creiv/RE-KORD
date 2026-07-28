//! Local folder browser under music_root (download destination).

use crate::path_util::{join_under_root, safe_dir_name, safe_rel_path, under_root};
use anyhow::{bail, Result};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirEntry {
    pub name: String,
    pub rel_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListResponse {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<FsDirEntry>,
    pub music_root: String,
}

pub fn list_dirs(music_root: &Path, rel: &str) -> Result<FsListResponse> {
    let path_rel = safe_rel_path(rel)?;
    let abs = join_under_root(music_root, &path_rel)?;
    if !abs.is_dir() || !under_root(&abs, music_root) {
        bail!("path not found");
    }
    let mut dirs = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&abs)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let child_rel = if path_rel.is_empty() {
            name.clone()
        } else {
            format!("{path_rel}/{name}")
        };
        dirs.push(FsDirEntry {
            name,
            rel_path: child_rel,
        });
    }
    let parent = if path_rel.is_empty() {
        None
    } else {
        let mut parts: Vec<&str> = path_rel.split('/').collect();
        parts.pop();
        Some(parts.join("/"))
    };
    Ok(FsListResponse {
        path: path_rel,
        parent,
        dirs,
        music_root: music_root.to_string_lossy().into_owned(),
    })
}

pub fn mkdir(music_root: &Path, parent: &str, name: &str) -> Result<String> {
    let parent_rel = safe_rel_path(parent)?;
    // Block creating folders deeper than Artist/Album (parent already ≥2 segments).
    let depth = parent_rel.split('/').filter(|s| !s.is_empty()).count();
    if depth >= 2 {
        bail!("cannot create folder inside an album directory");
    }
    let dir_name = safe_dir_name(name)?;
    let abs_parent = join_under_root(music_root, &parent_rel)?;
    if !abs_parent.is_dir() || !under_root(&abs_parent, music_root) {
        bail!("parent not found");
    }
    let dest = abs_parent.join(&dir_name);
    if dest.exists() {
        bail!("already exists");
    }
    fs::create_dir(&dest)?;
    let rel = if parent_rel.is_empty() {
        dir_name
    } else {
        format!("{parent_rel}/{dir_name}")
    };
    Ok(rel)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchHit {
    pub name: String,
    pub rel_path: String,
}

pub fn search_dirs(music_root: &Path, q: &str, limit: usize) -> Result<(Vec<FsSearchHit>, bool)> {
    let query = q.trim().to_lowercase();
    if query.len() < 2 {
        return Ok((vec![], false));
    }
    let mut results = Vec::new();
    let mut truncated = false;
    fn walk(
        root: &Path,
        dir: &Path,
        prefix: &str,
        query: &str,
        results: &mut Vec<FsSearchHit>,
        limit: usize,
        truncated: &mut bool,
        depth: usize,
    ) {
        if results.len() >= limit || depth > 3 {
            if results.len() >= limit {
                *truncated = true;
            }
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            if results.len() >= limit {
                *truncated = true;
                return;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if name.to_lowercase().contains(query) {
                results.push(FsSearchHit {
                    name: name.clone(),
                    rel_path: rel.clone(),
                });
            }
            // Only descend one level under artist for album search.
            if depth < 2 {
                walk(
                    root,
                    &entry.path(),
                    &rel,
                    query,
                    results,
                    limit,
                    truncated,
                    depth + 1,
                );
            }
        }
    }
    walk(
        music_root,
        music_root,
        "",
        &query,
        &mut results,
        limit,
        &mut truncated,
        0,
    );
    Ok((results, truncated))
}
