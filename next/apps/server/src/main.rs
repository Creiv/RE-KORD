use anyhow::Result;
use clap::Parser;
use rekord_core::backup;
use rekord_core::modules::{load_registry, write_default_manifest};
use rekord_core::{serve, AppConfig, AppState};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "rekord-server", about = "RE-KORD server hub")]
struct Args {
    /// Bind address (0.0.0.0 for LAN / remote access; use 127.0.0.1 for local-only)
    #[arg(long, env = "REKORD_BIND", default_value = "0.0.0.0:7420")]
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

    /// Directory with built client UI (served at `/` for LAN / tunnel)
    #[arg(long, env = "REKORD_CLIENT_UI")]
    client_ui: Option<PathBuf>,

    /// Directory with built admin UI (used only if client UI is not found)
    #[arg(long, env = "REKORD_ADMIN_UI")]
    admin_ui: Option<PathBuf>,

    /// Restore a backup ZIP (v2/v3) from disk before serving
    #[arg(long, env = "REKORD_RESTORE_ZIP")]
    restore_zip: Option<PathBuf>,

    /// Exit after --restore-zip instead of serving
    #[arg(long, default_value_t = false)]
    restore_exit: bool,
}

fn resolve_public_ui_dir(args: &Args) -> Option<PathBuf> {
    if let Some(dir) = args.client_ui.clone().filter(|p| p.is_dir()) {
        return Some(dir);
    }

    let mut client_candidates = vec![
        PathBuf::from("apps/client-ui/dist"),
        PathBuf::from("next/apps/client-ui/dist"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            client_candidates.push(dir.join("client-ui"));
            client_candidates.push(dir.join("web"));
        }
    }
    if let Some(dir) = client_candidates.into_iter().find(|p| p.is_dir()) {
        return Some(dir);
    }

    if let Some(dir) = args.admin_ui.clone().filter(|p| p.is_dir()) {
        return Some(dir);
    }

    let mut admin_candidates = vec![
        PathBuf::from("apps/server-ui/dist"),
        PathBuf::from("next/apps/server-ui/dist"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            admin_candidates.push(dir.join("admin-ui"));
        }
    }
    admin_candidates.into_iter().find(|p| p.is_dir())
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
    let mut config = AppConfig::resolve(args.data_dir.clone(), args.bind, args.modules_manifest.clone());
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

    let public_ui = resolve_public_ui_dir(&args);

    let bind = config.bind;
    let state = AppState::new(config, modules)?;

    if let Some(zip_path) = args.restore_zip {
        info!(path = %zip_path.display(), "restoring backup zip from disk");
        let bytes = std::fs::read(&zip_path)?;
        let report = backup::restore_backup_zip(&state, bytes).await?;
        info!(
            version = report.version,
            favorites = report.favorites,
            playlists = report.playlists,
            playlist_tracks = report.playlist_tracks,
            library_files = report.library_files,
            scanned_tracks = report.scanned_tracks,
            "restore finished"
        );
        if args.restore_exit {
            return Ok(());
        }
    }

    serve(state, bind, public_ui).await?;
    Ok(())
}
