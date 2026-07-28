use anyhow::{Context, Result};
use rekord_plugin_api::ModuleRegistry;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Default)]
struct ModulesFlags {
    #[serde(default)]
    plectr: bool,
    #[serde(default, rename = "web-share")]
    web_share: bool,
    #[serde(default)]
    nebula: bool,
    #[serde(default)]
    studio: bool,
    #[serde(default)]
    themes: bool,
}

/// Load module flags from TOML-like key=value file (minimal parser for MVP).
pub fn load_registry(path: &Path) -> Result<ModuleRegistry> {
    if !path.exists() {
        return Ok(ModuleRegistry::from_enabled_flags(
            false, false, false, false, false,
        ));
    }
    let raw = fs::read_to_string(path).context("read modules manifest")?;
    // Prefer serde via a tiny TOML subset: use toml crate? Not in deps.
    // Parse simple `key = true/false` under [modules].
    let mut flags = ModulesFlags::default();
    let mut in_modules = false;
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line == "[modules]" {
            in_modules = true;
            continue;
        }
        if line.starts_with('[') {
            in_modules = false;
            continue;
        }
        if !in_modules {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().eq_ignore_ascii_case("true");
            match k {
                "plectr" => flags.plectr = v,
                "web-share" => flags.web_share = v,
                "nebula" => flags.nebula = v,
                "studio" => flags.studio = v,
                "themes" => flags.themes = v,
                _ => {}
            }
        }
    }
    Ok(ModuleRegistry::from_enabled_flags(
        flags.plectr,
        flags.web_share,
        flags.nebula,
        flags.studio,
        flags.themes,
    ))
}

pub fn write_default_manifest(path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        path,
        r#"[modules]
plectr = false
web-share = false
nebula = false
studio = false
themes = false
"#,
    )?;
    Ok(())
}
