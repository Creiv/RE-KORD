use anyhow::Result;
use clap::Parser;
use rekord_core::modules::{load_registry, write_default_manifest};
use rekord_core::{serve, AppConfig, AppState};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "rekord-server", about = "RE-KORD server hub")]
struct Args {
    /// Bind address
    #[arg(long, env = "REKORD_BIND", default_value = "127.0.0.1:7420")]
    bind: SocketAddr,

    /// Data directory (DB, settings)
    #[arg(long, env = "REKORD_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// Music library root (optional; can be set via admin API/UI)
    #[arg(long, env = "REKORD_MUSIC_ROOT")]
    music_root: Option<PathBuf>,

    /// Path to modules.manifest.toml
    #[arg(long, env = "REKORD_MODULES_MANIFEST")]
    modules_manifest: Option<PathBuf>,

    /// Directory with built admin UI (server-ui dist)
    #[arg(long, env = "REKORD_ADMIN_UI")]
    admin_ui: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();
    let mut config = AppConfig::resolve(args.data_dir, args.bind, args.modules_manifest);
    config.ensure_dirs()?;
    write_default_manifest(&config.modules_manifest)?;
    config.set_music_root_if_present(args.music_root.as_deref())?;

    let modules = load_registry(&config.modules_manifest)?;
    info!(
        data_dir = %config.data_dir.display(),
        bind = %config.bind,
        enabled_modules = ?modules.enabled_ids(),
        "starting RE-KORD server"
    );

    let admin_ui = args.admin_ui.or_else(|| {
        let mut candidates = vec![
            PathBuf::from("apps/server-ui/dist"),
            PathBuf::from("next/apps/server-ui/dist"),
        ];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("admin-ui"));
            }
        }
        candidates.into_iter().find(|p| p.is_dir())
    });

    let bind = config.bind;
    let state = AppState::new(config, modules)?;
    serve(state, bind, admin_ui).await?;
    Ok(())
}
