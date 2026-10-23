use anyhow::Result;
use clap::Parser;
use rekord_core::backup;
use rekord_core::{prepare_hub_state, run_hub, shutdown_signal, AppConfig, HubOptions, UiDirs};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
enum PreventSleepArg {
    Off,
    Always,
    #[value(alias = "whenActive", alias = "when_active")]
    WhenActive,
}

impl PreventSleepArg {
    fn as_env(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Always => "always",
            Self::WhenActive => "when-active",
        }
    }
}

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

    /// Keep the computer from going to sleep: off, always (while the hub
    /// runs) or when-active (while it streams, scans, downloads or serves the
    /// tunnel, plus a grace period). Overrides and locks the admin panel's
    /// setting. The display may still turn off.
    #[arg(long, env = "REKORD_PREVENT_SLEEP", value_enum)]
    prevent_sleep: Option<PreventSleepArg>,

    /// Restore a backup ZIP (v2/v3) from disk before serving
    #[arg(long, env = "REKORD_RESTORE_ZIP")]
    restore_zip: Option<PathBuf>,

    /// Exit after --restore-zip instead of serving
    #[arg(long, default_value_t = false)]
    restore_exit: bool,

    /// One-shot: import legacy RE-KORD data from music_root/.kord (library
    /// metadata, accounts, favorites, playlists, moods, blocked tracks, play
    /// counts, settings) into the hub, merging with what it already has
    #[arg(long, visible_alias = "legacy-import", default_value_t = false)]
    sync_legacy_meta: bool,

    /// With --legacy-import: print what would be imported, write nothing
    #[arg(long, default_value_t = false)]
    legacy_import_dry_run: bool,

    /// With --legacy-import: merge again accounts already imported from the
    /// same legacy files (brings back what was removed since)
    #[arg(long, default_value_t = false)]
    legacy_import_force: bool,

    /// Exit after --legacy-import instead of serving
    #[arg(long, visible_alias = "legacy-import-exit", default_value_t = false)]
    sync_legacy_exit: bool,
}

fn resolve_client_ui_dir(args: &Args) -> Option<PathBuf> {
    if let Some(dir) = args.client_ui.clone().filter(|p| p.is_dir()) {
        return Some(dir);
    }
    let mut candidates = vec![PathBuf::from("apps/client-ui/dist")];
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
    let mut candidates = vec![PathBuf::from("apps/server-ui/dist")];
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

fn main() -> Result<()> {
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
    // `run_hub` reads the manifest path from the environment; set it before
    // the runtime starts any thread.
    if let Some(manifest) = &args.modules_manifest {
        std::env::set_var("REKORD_MODULES_MANIFEST", manifest);
    }
    // The hub config reads the mode from the environment (the desktop server
    // flavor has no flags, only the variable).
    if let Some(mode) = args.prevent_sleep {
        std::env::set_var("REKORD_PREVENT_SLEEP", mode.as_env());
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async_main(args))
}

async fn async_main(args: Args) -> Result<()> {
    let ui = resolve_ui_dirs(&args);
    let opts = HubOptions {
        bind: args.bind,
        data_dir: args
            .data_dir
            .clone()
            .unwrap_or_else(AppConfig::default_data_dir),
        client_ui_dir: ui.client,
        admin_ui_dir: ui.admin,
    };

    if let Some(root) = args.music_root.as_deref() {
        let mut config = AppConfig::resolve(Some(opts.data_dir.clone()), opts.bind, None);
        config.ensure_dirs()?;
        config.save_music_root(root.to_path_buf())?;
    }

    // One-shot maintenance tasks run on their own state before serving.
    if args.restore_zip.is_some() || args.sync_legacy_meta {
        let state = prepare_hub_state(&opts, None, args.modules_manifest.clone())?;

        if let Some(zip_path) = args.restore_zip.as_ref() {
            info!(path = %zip_path.display(), "restoring backup zip from disk");
            let bytes = std::fs::read(zip_path)?;
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
                let cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
                (cfg.data_dir.clone(), cfg.music_root.clone())
            };
            let Some(root) = root else {
                anyhow::bail!(
                    "--legacy-import requires music_root (set via settings or --music-root)"
                );
            };
            if !root.join(".kord").is_dir() {
                anyhow::bail!(
                    "no legacy data: {} does not exist",
                    root.join(".kord").display()
                );
            }
            info!(
                path = %root.display(),
                dry_run = args.legacy_import_dry_run,
                "importing legacy RE-KORD data"
            );
            let report = backup::run_legacy_import(
                &state.db,
                &data_dir,
                &root,
                backup::LegacyImportOptions {
                    trigger: backup::LegacyImportTrigger::Cli,
                    dry_run: args.legacy_import_dry_run,
                    force: args.legacy_import_force,
                    ..Default::default()
                },
            )?;
            // The full report (per account, unmatched paths) on stdout.
            println!("{}", serde_json::to_string_pretty(&report)?);
            if args.sync_legacy_exit || args.legacy_import_dry_run {
                return Ok(());
            }
        }
    }

    run_hub(opts, shutdown_signal()).await
}
