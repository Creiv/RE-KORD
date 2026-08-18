use crate::config::AppConfig;
use crate::db::Db;
use crate::scan;
use rekord_plugin_api::ModuleRegistry;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{error, info, warn};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,
    pub db: Db,
    pub modules: Arc<ModuleRegistry>,
    /// True while a library scan is in progress.
    pub scanning: Arc<AtomicBool>,
    /// Active Studio downloads: downloadId → cancel flag.
    pub active_downloads: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Filesystem watcher runtime for the music root.
    pub watcher: crate::watcher::SharedWatcher,
    /// Background job registry (scan, thumbnails, restore, legacy sync).
    pub jobs: crate::jobs::SharedJobs,
}

impl AppState {
    pub fn new(config: AppConfig, modules: ModuleRegistry) -> anyhow::Result<Self> {
        config.ensure_dirs()?;
        let _ = crate::accounts::ensure_accounts(&config.data_dir)?;
        let db = Db::open(config.db_path())?;
        Ok(Self {
            config: Arc::new(Mutex::new(config)),
            db,
            modules: Arc::new(modules),
            scanning: Arc::new(AtomicBool::new(false)),
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
            watcher: Arc::new(crate::watcher::WatcherRuntime::new()),
            jobs: Arc::new(crate::jobs::JobRegistry::new()),
        })
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::SeqCst)
    }

    /// Returns true if this caller acquired the scan lock.
    pub fn try_begin_scan(&self) -> bool {
        self.scanning
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn end_scan(&self) {
        self.scanning.store(false, Ordering::SeqCst);
    }

    /// Autoscan when music_root is set and the library was never indexed.
    pub fn needs_initial_scan(&self) -> bool {
        let root = {
            let cfg = self.config.lock().unwrap();
            cfg.music_root.clone()
        };
        let Some(root) = root else {
            return false;
        };
        if !root.is_dir() {
            warn!(path = %root.display(), "music_root missing or not a directory; skip autoscan");
            return false;
        }
        match self.db.stats(None) {
            Ok(s) => s.last_scan_at.is_none(),
            Err(e) => {
                warn!(error = %e, "could not read library stats for autoscan decision");
                true
            }
        }
    }

    /// Run scan on a blocking thread if idle. Used by API and startup autoscan.
    pub async fn run_scan_blocking(&self) -> anyhow::Result<scan::ScanReport> {
        self.run_scan_mode(scan::ScanMode::Incremental).await
    }

    pub async fn run_scan_mode(&self, mode: scan::ScanMode) -> anyhow::Result<scan::ScanReport> {
        if !self.try_begin_scan() {
            anyhow::bail!("scan already in progress");
        }
        {
            let data_dir = self.config.lock().unwrap().data_dir.clone();
            crate::diagnostics::append_activity(
                &data_dir,
                "scan",
                &format!("library scan started ({})", mode.as_str()),
            );
        }
        let root = {
            let cfg = self.config.lock().unwrap();
            cfg.music_root.clone()
        };
        let Some(root) = root else {
            self.end_scan();
            anyhow::bail!("music_root not set");
        };
        let db = self.db.clone();
        let data_dir = self.config.lock().unwrap().data_dir.clone();
        let job = self
            .jobs
            .start("scan", &format!("Scan libreria ({})", mode.as_str()), false);
        let result = tokio::task::spawn_blocking(move || {
            job.message("indicizzazione file");
            let report = scan::scan_library_with(&db, &root, mode)?;
            job.progress(0.8, "metadati legacy");
            // After every scan, fill gaps from legacy library DB / sidecars (never wipe richer hub data).
            match crate::backup::sync_restored_library_metadata(&db, &root) {
                Ok((albums, tracks)) => {
                    let _ = db.clear_weak_studio_placeholders();
                    if albums > 0 || tracks > 0 {
                        info!(
                            album_meta_merged = albums,
                            track_meta_merged = tracks,
                            "merged legacy studio metadata after scan"
                        );
                    }
                }
                Err(e) => warn!(error = %e, "legacy metadata sync after scan failed"),
            }
            // Personal moods: fill missing keys only (do not clobber next-only edits).
            match crate::backup::import_legacy_account_user_state(
                &data_dir,
                &root,
                crate::backup::MoodImportMode::FillEmpty,
            ) {
                Ok((accounts, moods)) => {
                    if accounts > 0 {
                        info!(
                            accounts_moods_synced = accounts,
                            moods_imported = moods,
                            "filled missing legacy personal moods after scan"
                        );
                    }
                }
                Err(e) => warn!(error = %e, "legacy mood sync after scan failed"),
            }
            job.finish(format!(
                "{} tracce indicizzate, {} rimosse",
                report.indexed_tracks, report.removed_tracks
            ));
            Ok(report)
        })
        .await;
        self.end_scan();
        match result {
            Ok(inner) => inner,
            Err(e) => Err(anyhow::anyhow!(e)),
        }
    }

    /// Fire-and-forget initial scan so HTTP comes up immediately.
    pub fn spawn_initial_scan_if_needed(&self) {
        if !self.needs_initial_scan() {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            info!("library never scanned — starting background index");
            match state.run_scan_blocking().await {
                Ok(report) => info!(
                    tracks = report.indexed_tracks,
                    files = report.scanned_files,
                    "background library scan complete"
                ),
                Err(e) => error!(error = %e, "background library scan failed"),
            }
        });
    }
}
