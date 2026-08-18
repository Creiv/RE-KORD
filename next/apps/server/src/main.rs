use anyhow::Result;
use clap::Parser;
use rekord_core::backup;
use rekord_core::modules::{load_registry, write_default_manifest};
use rekord_core::{serve, AppConfig, AppState, UiDirs};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

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

    /// Directory with built admin UI (served at `/admin`)
    #[arg(long, env = "REKORD_ADMIN_UI")]
    admin_ui: Option<PathBuf>,

    /// Restore a backup ZIP (v2/v3) from disk before serving
    #[arg(long, env = "REKORD_RESTORE_ZIP")]
    restore_zip: Option<PathBuf>,

    /// Exit after --restore-zip instead of serving
    #[arg(long, default_value_t = false)]
    restore_exit: bool,

    /// One-shot: sync studio metadata + personal moods from music_root/.kord into the hub DB
    #[arg(long, default_value_t = false)]
    sync_legacy_meta: bool,

    /// Exit after --sync-legacy-meta instead of serving
    #[arg(long, default_value_t = false)]
    sync_legacy_exit: bool,
}

fn resolve_client_ui_dir(args: &Args) -> Option<PathBuf> {
    if let Some(dir) = args.client_ui.clone().filter(|p| p.is_dir()) {
        return Some(dir);
    }
    let mut candidates = vec![
        PathBuf::from("apps/client-ui/dist"),
        PathBuf::from("next/apps/client-ui/dist"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("client-ui"));
            candidates.push(dir.join("web"));
        }
    }
    candidates.into_iter().find(|p| p.is_dir())
}

fn resolve_admin_ui_dir(args: &Args) -> Option<PathBuf> {
    if let Some(dir) = args.admin_ui.clone().filter(|p| p.is_dir()) {
        return Some(dir);
    }
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
}

/// The admin panel lives on `/admin`; when no client bundle exists it also
/// answers on `/` so a fresh install still has a usable page.
fn resolve_ui_dirs(args: &Args) -> UiDirs {
    let admin = resolve_admin_ui_dir(args);
    let client = resolve_client_ui_dir(args).or_else(|| admin.clone());
    UiDirs { client, admin }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Structured logs + recent-errors buffer exposed via /api/v1/diagnostics.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(rekord_core::errors::ErrorBufferLayer)
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

    let ui = resolve_ui_dirs(&args);

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
            album_meta_merged = report.album_meta_merged,
            track_meta_merged = report.track_meta_merged,
            "restore finished"
        );
        if args.restore_exit {
            return Ok(());
        }
    }

    if args.sync_legacy_meta {
        let (data_dir, root) = {
            let cfg = state.config.lock().unwrap();
            (cfg.data_dir.clone(), cfg.music_root.clone())
        };
        let Some(root) = root else {
            anyhow::bail!("--sync-legacy-meta requires music_root (set via settings or --music-root)");
        };
        info!(path = %root.display(), "syncing legacy library metadata + personal data");
        let report = backup::sync_legacy_library_data(&state.db, &data_dir, &root)?;
        info!(
            album_meta_merged = report.album_meta_merged,
            track_meta_merged = report.track_meta_merged,
            accounts_moods_synced = report.accounts_moods_synced,
            moods_imported = report.moods_imported,
            favorites_linked = report.favorites_linked,
            playlists_imported = report.playlists_imported,
            playlist_tracks_linked = report.playlist_tracks_linked,
            selections_imported = report.selections_imported,
            accounts_registry = report.accounts_registry,
            "legacy sync finished"
        );
        if args.sync_legacy_exit {
            return Ok(());
        }
    }

    serve(state, bind, ui).await?;
    Ok(())
}
