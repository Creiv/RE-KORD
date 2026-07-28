use serde::{Deserialize, Serialize};

/// Declares an optional RE-KORD module (disabled by default until confirmed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub enabled: bool,
}

/// Registry of known optional modules. Implementations load only enabled ones.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModuleRegistry {
    pub modules: Vec<ModuleManifest>,
}

impl ModuleRegistry {
    pub fn from_enabled_flags(
        plectr: bool,
        web_share: bool,
        nebula: bool,
        studio: bool,
        themes: bool,
    ) -> Self {
        Self {
            modules: vec![
                ModuleManifest {
                    id: "plectr".into(),
                    name: "Plectr".into(),
                    version: "0.0.0".into(),
                    description: "Rhythm game module (stub)".into(),
                    enabled: plectr,
                },
                ModuleManifest {
                    id: "web-share".into(),
                    name: "Web Share".into(),
                    version: "0.0.0".into(),
                    description: "Remote web sharing (stub)".into(),
                    enabled: web_share,
                },
                ModuleManifest {
                    id: "nebula".into(),
                    name: "Nebula".into(),
                    version: "0.0.0".into(),
                    description: "Sonic Nebula visualization (stub)".into(),
                    enabled: nebula,
                },
                ModuleManifest {
                    id: "studio".into(),
                    name: "Studio".into(),
                    version: "0.0.0".into(),
                    description: "Download and metadata tools (stub)".into(),
                    enabled: studio,
                },
                ModuleManifest {
                    id: "themes".into(),
                    name: "Themes".into(),
                    version: "0.0.0".into(),
                    description: "Extra themes and graphics (stub)".into(),
                    enabled: themes,
                },
            ],
        }
    }

    pub fn enabled_ids(&self) -> Vec<&str> {
        self.modules
            .iter()
            .filter(|m| m.enabled)
            .map(|m| m.id.as_str())
            .collect()
    }
}
