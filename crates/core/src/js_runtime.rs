//! JavaScript runtime handed to yt-dlp (`--js-runtimes <name>:<path>`).
//!
//! YouTube answers yt-dlp without a JS runtime with "The page needs to be
//! reloaded" (or a sign-in request): its player challenges are solved by
//! running JavaScript. The server packages ship QuickJS-ng (`qjs`, a few MB);
//! a desktop app launched from the menu does not see runtimes installed in a
//! shell profile (nvm, deno, bun), so common install locations are probed too.
//!
//! Lookup order (the first usable one wins):
//!
//! 1. `REKORD_YTDLP_JS_RUNTIME`: `none` / `0` / `off` disables it; otherwise
//!    a `name:path` pair, an absolute path or a bare name looked up on PATH;
//! 2. the bundled runtime: `REKORD_YTDLP_JS_BIN`, then `qjs` (or `deno`) in the
//!    folders of the bundled tools and next to `YTDLP_PATH`;
//! 3. deno, node, bun or qjs on PATH;
//! 4. common install locations missing from a GUI PATH: `~/.deno/bin`,
//!    `~/.bun/bin`, nvm's newest node, `/usr/local/bin`, `/opt/homebrew/bin`
//!    (Windows: `%USERPROFILE%\.deno\bin`, `%USERPROFILE%\.bun\bin`,
//!    `%ProgramFiles%\nodejs`).
//!
//! Runtimes found on PATH or in common locations must run and meet yt-dlp's
//! minimum version (an old system node is skipped); the explicit setting is
//! taken as is. Probing runs subprocesses, so it happens off the async workers
//! and the result is cached for [`crate::tools::VERSION_TTL`].

use crate::tools::{self, VERSION_TTL};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Explicit runtime (`none`, `name:path`, a path or a name).
pub const ENV_RUNTIME: &str = "REKORD_YTDLP_JS_RUNTIME";
/// Runtime bundled with the package (set by the desktop app, `run.sh`, Docker).
pub const ENV_BUNDLED: &str = "REKORD_YTDLP_JS_BIN";

/// yt-dlp runtime names with their executable stem, in PATH preference order.
const KINDS: [(&str, &str); 4] = [
    ("deno", "deno"),
    ("node", "node"),
    ("bun", "bun"),
    ("quickjs", "qjs"),
];

/// Oldest version yt-dlp accepts (wiki "EJS"); QuickJS has no hard minimum.
pub fn minimum_version(name: &str) -> Option<&'static [u64]> {
    match name {
        "deno" => Some(&[2, 3, 0]),
        "node" => Some(&[22, 0, 0]),
        "bun" => Some(&[1, 2, 11]),
        _ => None,
    }
}

/// yt-dlp runtime name for an executable (`qjs.exe` → `quickjs`).
pub fn kind_for_file(path: &Path) -> Option<&'static str> {
    let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
    match stem.as_str() {
        "deno" => Some("deno"),
        "node" | "nodejs" => Some("node"),
        "bun" => Some("bun"),
        "qjs" | "quickjs" => Some("quickjs"),
        _ => None,
    }
}

/// The version token of a runtime's `--version` output (`deno 2.9.7 (…)`,
/// `v22.16.0`, `1.2.19`, `0.17.0`).
pub fn parse_runtime_version(text: &str) -> Option<String> {
    let first = text.lines().next()?.trim();
    first.split_whitespace().find_map(|tok| {
        let t = tok.trim_start_matches(['v', 'V']);
        let t = t.trim_end_matches([',', ';', ')']);
        (t.chars().next()?.is_ascii_digit()).then(|| t.to_string())
    })
}

/// `version` is at least `min` (unparseable versions pass).
fn meets_minimum(version: &str, min: &[u64]) -> bool {
    let Some(nums) = tools::parse_version_numbers(version) else {
        return true;
    };
    for i in 0..min.len().max(nums.len()) {
        let a = nums.get(i).copied().unwrap_or(0);
        let b = min.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsRuntime {
    /// yt-dlp name: `deno`, `node`, `bun`, `quickjs` (or what the setting names).
    pub name: String,
    pub path: PathBuf,
    /// `env`, `bundled`, `path` or `common`.
    pub source: &'static str,
    pub version: Option<String>,
}

impl JsRuntime {
    /// `--js-runtimes` value.
    pub fn arg(&self) -> String {
        format!("{}:{}", self.name, self.path.display())
    }
}

/// Outcome of a lookup.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    pub runtime: Option<JsRuntime>,
    /// `REKORD_YTDLP_JS_RUNTIME=none`.
    pub disabled: bool,
}

/// What a candidate's probe found: `None` = it does not run, `Some(version)`.
pub type Probe = Option<Option<String>>;

/// Everything the lookup reads from the environment, explicit for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Lookup {
    pub setting: Option<String>,
    pub bundled_bin: Option<PathBuf>,
    pub bundled_dirs: Vec<PathBuf>,
    pub path_var: Option<OsString>,
    pub home: Option<PathBuf>,
    pub nvm_dir: Option<PathBuf>,
    /// System folders often missing from a GUI PATH.
    pub extra_dirs: Vec<PathBuf>,
    pub windows: bool,
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Lookup {
    pub fn from_env() -> Self {
        let windows = cfg!(windows);
        let mut bundled_dirs: Vec<PathBuf> = tools::bundled_dirs()
            .into_iter()
            .map(|(dir, _)| dir)
            .collect();
        if let Some(dir) = env_nonempty("YTDLP_PATH")
            .map(PathBuf::from)
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .filter(|d| !d.as_os_str().is_empty())
        {
            bundled_dirs.insert(0, dir);
        }
        let home = if windows {
            env_nonempty("USERPROFILE")
        } else {
            env_nonempty("HOME")
        }
        .map(PathBuf::from);
        let extra_dirs = if windows {
            env_nonempty("ProgramFiles")
                .map(|p| vec![PathBuf::from(p).join("nodejs")])
                .unwrap_or_default()
        } else {
            vec![
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/opt/homebrew/bin"),
            ]
        };
        Self {
            setting: env_nonempty(ENV_RUNTIME),
            bundled_bin: env_nonempty(ENV_BUNDLED).map(PathBuf::from),
            bundled_dirs,
            path_var: std::env::var_os("PATH"),
            home,
            nvm_dir: env_nonempty("NVM_DIR").map(PathBuf::from),
            extra_dirs,
            windows,
        }
    }

    fn exe(&self, stem: &str) -> String {
        if self.windows {
            format!("{stem}.exe")
        } else {
            stem.to_string()
        }
    }

    fn which(&self, stem: &str) -> Option<PathBuf> {
        let path_var = self.path_var.as_ref()?;
        let name = self.exe(stem);
        std::env::split_paths(path_var)
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(|dir| dir.join(&name))
            .find(|p| p.is_file())
    }

    /// nvm's installed node binaries, newest first.
    fn nvm_nodes(&self) -> Vec<PathBuf> {
        let Some(root) = self
            .nvm_dir
            .clone()
            .or_else(|| self.home.as_ref().map(|h| h.join(".nvm")))
        else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(root.join("versions/node")) else {
            return Vec::new();
        };
        let mut found: Vec<(Vec<u64>, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let ver = tools::parse_version_numbers(&name)?;
                Some((ver, e.path().join("bin").join(self.exe("node"))))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0));
        found.into_iter().map(|(_, p)| p).collect()
    }

    /// Candidates after the setting, in priority order (existing files only).
    fn candidates(&self) -> Vec<(&'static str, PathBuf, &'static str)> {
        let mut out: Vec<(&'static str, PathBuf, &'static str)> = Vec::new();
        if let Some(p) = &self.bundled_bin {
            out.push((kind_for_file(p).unwrap_or("quickjs"), p.clone(), "bundled"));
        }
        for dir in &self.bundled_dirs {
            for (name, stem) in [("quickjs", "qjs"), ("deno", "deno")] {
                out.push((name, dir.join(self.exe(stem)), "bundled"));
            }
        }
        for (name, stem) in KINDS {
            if let Some(p) = self.which(stem) {
                out.push((name, p, "path"));
            }
        }
        if let Some(home) = &self.home {
            out.push((
                "deno",
                home.join(".deno").join("bin").join(self.exe("deno")),
                "common",
            ));
            out.push((
                "bun",
                home.join(".bun").join("bin").join(self.exe("bun")),
                "common",
            ));
        }
        for p in self.nvm_nodes() {
            out.push(("node", p, "common"));
        }
        for dir in &self.extra_dirs {
            for (name, stem) in KINDS {
                out.push((name, dir.join(self.exe(stem)), "common"));
            }
        }
        let mut seen = std::collections::HashSet::new();
        out.into_iter()
            .filter(|(_, p, _)| p.is_file())
            .filter(|(_, p, _)| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
            .collect()
    }

    /// The runtime the setting names, if it points at something usable.
    fn named_by_setting(&self, raw: &str) -> Option<JsRuntime> {
        let explicit = |name: &str, path: PathBuf| JsRuntime {
            name: name.to_string(),
            path,
            source: "env",
            version: None,
        };
        if let Some((rt, path)) = raw.split_once(':') {
            // `C:\…` is a Windows drive, not a `name:path` pair.
            let drive = rt.len() == 1 && (self.windows || cfg!(windows));
            if !drive && !rt.is_empty() && !path.is_empty() {
                return Some(explicit(rt, PathBuf::from(path)));
            }
        }
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            return p
                .is_file()
                .then(|| explicit(kind_for_file(&p).unwrap_or("node"), p));
        }
        let (name, stem) = KINDS
            .iter()
            .find(|(name, stem)| raw == *name || raw == *stem)
            .copied()
            .unwrap_or(("node", raw));
        let name = kind_for_file(Path::new(stem)).unwrap_or(name);
        self.which(stem).map(|abs| explicit(name, abs))
    }

    /// Pick a runtime. `probe` runs a candidate (`--version`); the quick,
    /// filesystem-only lookup passes `|_, _| Some(None)`.
    pub fn select(&self, probe: impl Fn(&str, &Path) -> Probe) -> Resolved {
        if let Some(raw) = &self.setting {
            if matches!(raw.to_ascii_lowercase().as_str(), "none" | "0" | "off") {
                return Resolved {
                    runtime: None,
                    disabled: true,
                };
            }
            if let Some(mut rt) = self.named_by_setting(raw) {
                rt.version = probe(&rt.name, &rt.path).flatten();
                return Resolved {
                    runtime: Some(rt),
                    disabled: false,
                };
            }
        }
        for (name, path, source) in self.candidates() {
            let probed = probe(name, &path);
            let version = match probed {
                Some(v) => v,
                // Bundled copies and deno / node / bun answer `--version`;
                // an old QuickJS may not, but still runs scripts.
                None if source != "bundled" && name == "quickjs" => None,
                None => continue,
            };
            if source != "bundled" {
                if let (Some(v), Some(min)) = (version.as_deref(), minimum_version(name)) {
                    if !meets_minimum(v, min) {
                        continue;
                    }
                }
            }
            return Resolved {
                runtime: Some(JsRuntime {
                    name: name.to_string(),
                    path,
                    source,
                    version,
                }),
                disabled: false,
            };
        }
        Resolved::default()
    }
}

/// `<runtime> --version` (blocking).
pub fn probe_blocking(_name: &str, path: &Path) -> Probe {
    tools::probe_program_blocking(path, &["--version"]).map(|t| parse_runtime_version(&t))
}

type Cache = Mutex<HashMap<Lookup, (Instant, Resolved)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn peek(lookup: &Lookup) -> Option<(Instant, Resolved)> {
    cache().lock().ok()?.get(lookup).cloned()
}

fn is_fresh(at: Instant) -> bool {
    at.elapsed() < VERSION_TTL
}

/// Probe and pick (blocking; never call on an async worker).
pub fn resolve_blocking() -> Resolved {
    let lookup = Lookup::from_env();
    if let Some((at, hit)) = peek(&lookup) {
        if is_fresh(at) {
            return hit;
        }
    }
    let resolved = lookup.select(probe_blocking);
    if let Ok(mut map) = cache().lock() {
        map.insert(lookup, (Instant::now(), resolved.clone()));
    }
    resolved
}

/// Resolve on the blocking pool (cached).
pub async fn resolve() -> Resolved {
    if let Some((at, hit)) = peek(&Lookup::from_env()) {
        if is_fresh(at) {
            return hit;
        }
    }
    tokio::task::spawn_blocking(resolve_blocking)
        .await
        .unwrap_or_default()
}

/// Refresh the cache in the background when it is stale or empty.
pub fn spawn_refresh() {
    if peek(&Lookup::from_env()).is_some_and(|(at, _)| is_fresh(at)) {
        return;
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async {
            let _ = resolve().await;
        });
    }
}

/// Best known runtime without running anything: the cached choice, else a
/// filesystem-only lookup (and a background probe for the next call).
pub fn quick() -> Option<JsRuntime> {
    let lookup = Lookup::from_env();
    if let Some((at, hit)) = peek(&lookup) {
        if !is_fresh(at) {
            spawn_refresh();
        }
        return hit.runtime;
    }
    spawn_refresh();
    lookup.select(|_, _| Some(None)).runtime
}

/// JSON status for diagnostics (`binaries.jsRuntime`).
pub fn status_json(r: &Resolved) -> serde_json::Value {
    match &r.runtime {
        Some(rt) => serde_json::json!({
            "available": true,
            "name": rt.name,
            "path": rt.path,
            "source": rt.source,
            "version": rt.version,
            "disabled": false,
        }),
        None => serde_json::json!({
            "available": false,
            "name": null,
            "path": null,
            "source": null,
            "version": null,
            "disabled": r.disabled,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!("rekord-js-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }

        fn file(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"").unwrap();
            p
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn runs(_: &str, _: &Path) -> Probe {
        Some(None)
    }

    fn pick(l: &Lookup) -> Option<(String, PathBuf, &'static str)> {
        l.select(runs).runtime.map(|r| (r.name, r.path, r.source))
    }

    #[test]
    fn parses_runtime_versions() {
        assert_eq!(
            parse_runtime_version("deno 2.9.7 (stable, release, x86_64)\nv8 14").as_deref(),
            Some("2.9.7")
        );
        assert_eq!(
            parse_runtime_version("v22.16.0\n").as_deref(),
            Some("22.16.0")
        );
        assert_eq!(parse_runtime_version("0.17.0").as_deref(), Some("0.17.0"));
        assert_eq!(
            parse_runtime_version("QuickJS version 2025-04-26").as_deref(),
            Some("2025-04-26")
        );
        assert_eq!(parse_runtime_version("usage: qjs"), None);
        assert!(meets_minimum("22.0.0", &[22, 0, 0]));
        assert!(meets_minimum("24.1.0", &[22, 0, 0]));
        assert!(!meets_minimum("20.19.2", &[22, 0, 0]));
        assert!(!meets_minimum("2.2.9", &[2, 3, 0]));
        assert!(meets_minimum("garbage", &[2, 3, 0]));
        assert_eq!(kind_for_file(Path::new("/x/qjs.exe")), Some("quickjs"));
        assert_eq!(kind_for_file(Path::new("/x/deno")), Some("deno"));
        assert_eq!(kind_for_file(Path::new("/x/python")), None);
    }

    #[test]
    fn setting_wins_and_can_disable() {
        let s = Scratch::new();
        let qjs = s.file("bin/qjs");
        let node = s.file("path/node");
        let base = Lookup {
            bundled_dirs: vec![qjs.parent().unwrap().to_path_buf()],
            path_var: Some(node.parent().unwrap().as_os_str().to_owned()),
            ..Default::default()
        };
        let none = Lookup {
            setting: Some("none".into()),
            ..base.clone()
        };
        assert_eq!(
            none.select(runs),
            Resolved {
                runtime: None,
                disabled: true
            }
        );
        let pair = Lookup {
            setting: Some("deno:/opt/deno/bin/deno".into()),
            ..base.clone()
        };
        assert_eq!(
            pick(&pair),
            Some(("deno".into(), PathBuf::from("/opt/deno/bin/deno"), "env"))
        );
        let abs = Lookup {
            setting: Some(qjs.display().to_string()),
            ..base.clone()
        };
        assert_eq!(pick(&abs), Some(("quickjs".into(), qjs.clone(), "env")));
        let name = Lookup {
            setting: Some("node".into()),
            ..base.clone()
        };
        assert_eq!(pick(&name), Some(("node".into(), node.clone(), "env")));
        // A setting pointing at nothing falls back to the lookup.
        let missing = Lookup {
            setting: Some("bun".into()),
            ..base.clone()
        };
        assert_eq!(pick(&missing), Some(("quickjs".into(), qjs, "bundled")));
    }

    #[test]
    fn bundled_before_path_before_common() {
        let s = Scratch::new();
        let bundled = s.file("pkg/qjs");
        let env_bin = s.file("elsewhere/qjs");
        let path_node = s.file("path/node");
        let path_deno = s.file("path/deno");
        let home_deno = s.file("home/.deno/bin/deno");
        let mut l = Lookup {
            bundled_bin: Some(env_bin.clone()),
            bundled_dirs: vec![bundled.parent().unwrap().to_path_buf()],
            path_var: Some(path_node.parent().unwrap().as_os_str().to_owned()),
            home: Some(s.0.join("home")),
            ..Default::default()
        };
        assert_eq!(pick(&l), Some(("quickjs".into(), env_bin, "bundled")));
        l.bundled_bin = None;
        assert_eq!(pick(&l), Some(("quickjs".into(), bundled, "bundled")));
        l.bundled_dirs.clear();
        // deno is preferred over node on PATH.
        assert_eq!(pick(&l), Some(("deno".into(), path_deno, "path")));
        l.path_var = Some(OsString::new());
        assert_eq!(pick(&l), Some(("deno".into(), home_deno, "common")));
        let _ = path_node;
    }

    #[test]
    fn common_locations_newest_nvm_and_minimum_versions() {
        let s = Scratch::new();
        let old = s.file("home/.nvm/versions/node/v20.19.2/bin/node");
        let new = s.file("home/.nvm/versions/node/v22.16.0/bin/node");
        let _newest_but_broken = s.file("home/.nvm/versions/node/v24.0.0/bin/node");
        let bun = s.file("home/.bun/bin/bun");
        let local_qjs = s.file("usr-local/qjs");
        let l = Lookup {
            home: Some(s.0.join("home")),
            extra_dirs: vec![local_qjs.parent().unwrap().to_path_buf()],
            ..Default::default()
        };
        // Filesystem only: bun (home) comes before nvm, nvm newest first.
        assert_eq!(pick(&l), Some(("bun".into(), bun.clone(), "common")));
        let probe = |name: &str, p: &Path| -> Probe {
            match name {
                "bun" => Some(Some("1.1.0".into())), // too old for yt-dlp
                "node" if p.to_string_lossy().contains("v24") => None, // does not run
                "node" if p == old.as_path() => Some(Some("20.19.2".into())),
                "node" => Some(Some("22.16.0".into())),
                _ => Some(Some("0.17.0".into())),
            }
        };
        let r = l.select(probe).runtime.unwrap();
        assert_eq!((r.name.as_str(), r.path.as_path()), ("node", new.as_path()));
        assert_eq!(r.version.as_deref(), Some("22.16.0"));
        // Nothing usable but an old node: QuickJS from /usr/local/bin.
        std::fs::remove_file(&new).unwrap();
        std::fs::remove_file(&bun).unwrap();
        let r = l.select(probe).runtime.unwrap();
        assert_eq!(
            (r.name.as_str(), r.path.as_path()),
            ("quickjs", local_qjs.as_path())
        );
        assert_eq!(Lookup::default().select(runs), Resolved::default());
    }

    #[test]
    fn bundled_copy_that_does_not_run_is_skipped() {
        let s = Scratch::new();
        let bundled = s.file("pkg/qjs");
        let path_node = s.file("path/node");
        let l = Lookup {
            bundled_dirs: vec![bundled.parent().unwrap().to_path_buf()],
            path_var: Some(path_node.parent().unwrap().as_os_str().to_owned()),
            ..Default::default()
        };
        let r = l
            .select(|name, _| (name != "quickjs").then_some(Some("22.1.0".into())))
            .runtime
            .unwrap();
        assert_eq!((r.name.as_str(), r.source), ("node", "path"));
        assert_eq!(r.arg(), format!("node:{}", path_node.display()));
    }
}
