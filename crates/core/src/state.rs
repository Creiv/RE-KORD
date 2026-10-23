use crate::config::AppConfig;
use crate::db::Db;
use crate::scan;
use rekord_plugin_api::ModuleRegistry;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{error, info, warn};

/// Error text of a scan request that found another scan running.
pub const SCAN_BUSY: &str = "scan already in progress";

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
    /// Podcasts module runtime (idle unless a client asks for a source).
    pub podcasts: Arc<crate::podcasts::Runtime>,
    /// "Prevent the computer from sleeping" (holds nothing while off).
    pub power: crate::power::PowerManager,
    /// Activity held while a scan runs (sleep prevention, `whenActive`).
    scan_activity: Arc<Mutex<Option<crate::power::ActivityGuard>>>,
    /// Scan counters used to coalesce "rescan, the library changed" requests.
    scan_generations: Arc<ScanGenerations>,
    /// The embedded-tags backfill job is running (one at a time).
    pub embedded_backfill: Arc<AtomicBool>,
    /// Bumped by every "re-read embedded tags" request, so a running backfill
    /// notices a newer request (and its override choice).
    pub embedded_reread_gen: Arc<std::sync::atomic::AtomicU64>,
    /// `REKORD_ACCESS_KEY` gate (`None`: no key required). Set by
    /// `prepare_hub_state`, never part of `AppConfig` (which is serialised).
    pub access_key: Option<Arc<crate::access_key::AccessGate>>,
}

/// `started` is bumped when a scan takes the lock, `completed` catches up when
/// it releases it. A change made at time T is covered by any scan whose
/// generation is greater than `started` at T.
#[derive(Default)]
struct ScanGenerations {
    started: AtomicU64,
    completed: AtomicU64,
    /// A background follow-up scan is already waiting (see `request_rescan`).
    queued: AtomicBool,
}

impl AppState {
    pub fn new(mut config: AppConfig, modules: ModuleRegistry) -> anyhow::Result<Self> {
        config.ensure_dirs()?;
        let _ = crate::accounts::ensure_accounts(&config.data_dir)?;
        let db = Db::open(config.db_path())?;
        // Discogs token / Cloudflare login / cookies of a legacy install, once.
        if let Err(e) =
            crate::backup::legacy_config::import_legacy_config_in_place(&mut config, &db)
        {
            warn!(error = %e, "legacy server settings import failed");
        }
        let power = crate::power::PowerManager::for_platform();
        power.configure(config.power);
        db.set_prefer_embedded(
            config.embedded.enabled
                && config.embedded.priority == crate::embedded::EmbeddedPriority::Embedded,
        );
        Ok(Self {
            config: Arc::new(Mutex::new(config)),
            db,
            modules: Arc::new(modules),
            scanning: Arc::new(AtomicBool::new(false)),
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
            watcher: Arc::new(crate::watcher::WatcherRuntime::new()),
            jobs: Arc::new(crate::jobs::JobRegistry::with_power(power.clone())),
            podcasts: Arc::new(crate::podcasts::Runtime::new()),
            power,
            scan_activity: Arc::new(Mutex::new(None)),
            scan_generations: Arc::new(ScanGenerations::default()),
            embedded_backfill: Arc::new(AtomicBool::new(false)),
            embedded_reread_gen: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            access_key: None,
        })
    }

    /// Embedded tags / covers as the hub settings say.
    pub fn embedded_options(&self) -> crate::embedded::EmbeddedOptions {
        crate::embedded::EmbeddedOptions::from_config(&self.config.lock().unwrap())
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::SeqCst)
    }

    /// Returns true if this caller acquired the scan lock.
    pub fn try_begin_scan(&self) -> bool {
        let acquired = self
            .scanning
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if acquired {
            self.scan_generations.started.fetch_add(1, Ordering::SeqCst);
            let activity = self.power.begin(crate::power::ActivityKind::Job);
            *self.scan_activity.lock().unwrap() = Some(activity);
        }
        acquired
    }

    /// The scan lock as a value that releases it when dropped. Moved into the
    /// blocking work, it ends when the work does, even when the request that
    /// started it is gone (a closed admin tab drops the handler's future, and
    /// the lock, the "scanning" flag and the sleep prevention would stay).
    pub fn try_scan_lease(&self) -> Option<ScanLease> {
        self.try_begin_scan().then(|| ScanLease(self.clone()))
    }

    pub fn end_scan(&self) {
        drop(self.scan_activity.lock().unwrap().take());
        let started = self.scan_generations.started.load(Ordering::SeqCst);
        self.scan_generations
            .completed
            .store(started, Ordering::SeqCst);
        self.scanning.store(false, Ordering::SeqCst);
    }

    /// Make sure the library is re-indexed *after* a change that just happened
    /// (a download finished, files were moved). If a scan is already running it
    /// may have missed the change, so this waits for it and runs one follow-up
    /// scan; concurrent callers share that follow-up instead of queueing one
    /// scan each. Returns once a scan that started after the call has finished.
    pub async fn rescan_after_change(&self) -> anyhow::Result<()> {
        let want = self.scan_generations.started.load(Ordering::SeqCst) + 1;
        loop {
            if self.scan_generations.completed.load(Ordering::SeqCst) >= want {
                return Ok(());
            }
            if !self.is_scanning() {
                match self
                    .run_scan(scan::ScanOptions {
                        mode: scan::ScanMode::Incremental,
                        trigger: scan::ScanTrigger::Automatic,
                        ..Default::default()
                    })
                    .await
                {
                    Ok(_) => return Ok(()),
                    // Lost the race for the lock: someone else's scan counts.
                    Err(e) if e.to_string() == SCAN_BUSY => {}
                    Err(e) => return Err(e),
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    /// Fire-and-forget [`AppState::rescan_after_change`]: requests made while a
    /// follow-up is already waiting are folded into it.
    pub fn request_rescan(&self) {
        if self.scan_generations.queued.swap(true, Ordering::SeqCst) {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            // Clear the flag before waiting: a request arriving while the
            // follow-up scan runs needs (and gets) another one.
            state.scan_generations.queued.store(false, Ordering::SeqCst);
            if let Err(e) = state.rescan_after_change().await {
                warn!(error = %e, "queued library rescan failed");
            }
        });
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
        // A schema upgrade marks files stale (`mtime = -1`) so their tags and
        // durations are re-read: rescan at startup instead of waiting for a change.
        let stale = self
            .db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM files WHERE mtime = -1)",
                    [],
                    |r| r.get::<_, bool>(0),
                )?)
            })
            .unwrap_or(false);
        if stale {
            return true;
        }
        match self.db.stats(None) {
            Ok(s) => s.last_scan_at.is_none(),
            Err(e) => {
                warn!(error = %e, "could not read library stats for autoscan decision");
                true
            }
        }
    }

    /// Automatic incremental scan on a blocking thread if idle (watcher,
    /// post-download, startup autoscan). Held to the stricter mass-deletion
    /// guard; use [`AppState::rescan_after_change`] to queue instead of failing
    /// when a scan is already running.
    pub async fn run_scan_blocking(&self) -> anyhow::Result<scan::ScanReport> {
        self.run_scan(scan::ScanOptions {
            mode: scan::ScanMode::Incremental,
            trigger: scan::ScanTrigger::Automatic,
            ..Default::default()
        })
        .await
    }

    /// Scan requested by a person (API "scan" button).
    pub async fn run_scan_mode(&self, mode: scan::ScanMode) -> anyhow::Result<scan::ScanReport> {
        self.run_scan(scan::ScanOptions {
            mode,
            trigger: scan::ScanTrigger::Manual,
            ..Default::default()
        })
        .await
    }

    /// Run a scan; `opts.embedded` is always taken from the hub settings.
    pub async fn run_scan(&self, mut opts: scan::ScanOptions) -> anyhow::Result<scan::ScanReport> {
        let mode = opts.mode;
        opts.embedded = self.embedded_options();
        let Some(lease) = self.try_scan_lease() else {
            anyhow::bail!(SCAN_BUSY);
        };
        {
            let data_dir = self.config.lock().unwrap().data_dir.clone();
            crate::diagnostics::log_activity(
                &data_dir,
                crate::diagnostics::ActivityEvent::new(
                    "scan",
                    "started",
                    format!("library scan started ({})", mode.as_str()),
                )
                .params(serde_json::json!({ "mode": mode.as_str() })),
            );
        }
        let root = {
            let cfg = self.config.lock().unwrap();
            cfg.music_root.clone()
        };
        let Some(root) = root else {
            anyhow::bail!("music_root not set");
        };
        let db = self.db.clone();
        let data_dir = self.config.lock().unwrap().data_dir.clone();
        let job = self.jobs.start_coded(
            "scan",
            &format!("Scan libreria ({})", mode.as_str()),
            "scan.title",
            serde_json::json!({ "mode": mode.as_str() }),
            false,
        );
        let result = tokio::task::spawn_blocking(move || {
            let _lease = lease;
            job.message_coded(
                "scan.indexing",
                serde_json::Value::Null,
                "indicizzazione file",
            );
            let report = match scan::scan_library_opts(&db, &root, opts) {
                Ok(r) => r,
                Err(e) => {
                    job.fail(e.to_string());
                    return Err(e);
                }
            };
            if let Some(reason) = &report.prune_skipped {
                crate::diagnostics::log_activity(
                    &data_dir,
                    crate::diagnostics::ActivityEvent::new(
                        "scan",
                        "pruneSkipped",
                        format!(
                            "{} tracce non trovate ma mantenute: {reason}",
                            report.missing_tracks
                        ),
                    )
                    .params(serde_json::json!({
                        "missing": report.missing_tracks,
                        "reason": reason,
                    })),
                );
            }
            job.progress_coded(0.8, "scan.metadata", serde_json::Value::Null, "metadati");
            post_scan_metadata(&db, &data_dir, &root);
            job.finish_coded(
                "scan.done",
                serde_json::json!({
                    "indexed": report.indexed_tracks,
                    "removed": report.removed_tracks,
                }),
                format!(
                    "{} tracce indicizzate, {} rimosse",
                    report.indexed_tracks, report.removed_tracks
                ),
            );
            Ok(report)
        })
        .await;
        match result {
            Ok(inner) => inner,
            Err(e) => Err(anyhow::anyhow!(e)),
        }
    }

    /// Re-index one folder (`artist` or `artist/album`) after a change made
    /// by the hub itself (a finished download). Waits for a running scan,
    /// then scans only that folder. Returns the new index epoch, which
    /// clients compare with `/library/stats` before reloading.
    pub async fn rescan_path(&self, rel_dir: &str) -> anyhow::Result<u64> {
        let root = self
            .config
            .lock()
            .unwrap()
            .music_root
            .clone()
            .ok_or_else(|| anyhow::anyhow!("music_root not set"))?;
        let lease = loop {
            if let Some(lease) = self.try_scan_lease() {
                break lease;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        };
        let db = self.db.clone();
        let data_dir = self.config.lock().unwrap().data_dir.clone();
        let rel = rel_dir.to_string();
        let embedded = self.embedded_options();
        let result = tokio::task::spawn_blocking(move || {
            let _lease = lease;
            let report = scan::scan_subtree(&db, &root, &rel, &embedded)?;
            post_scan_metadata(&db, &data_dir, &root);
            Ok::<_, anyhow::Error>(report.index_epoch)
        })
        .await;
        match result {
            Ok(inner) => inner,
            Err(e) => Err(anyhow::anyhow!(e)),
        }
    }

    /// Fire-and-forget initial scan so HTTP comes up immediately. On an
    /// already indexed library, a pending first legacy import runs instead.
    pub fn spawn_initial_scan_if_needed(&self) {
        if !self.needs_initial_scan() {
            self.spawn_pending_legacy_import();
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

    /// Upgrade from a legacy install whose library was already indexed by
    /// next: run the one-time legacy import now (under the scan lock).
    fn spawn_pending_legacy_import(&self) {
        let (data_dir, root) = {
            let cfg = self.config.lock().unwrap();
            (cfg.data_dir.clone(), cfg.music_root.clone())
        };
        let Some(root) = root else {
            return;
        };
        if !crate::backup::legacy_import_pending(&data_dir, &root) {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            if !state.try_begin_scan() {
                // A scan is running: it imports when it finishes.
                return;
            }
            let db = state.db.clone();
            let out = tokio::task::spawn_blocking(move || {
                crate::backup::auto_import_legacy_once(&db, &data_dir, &root)
            })
            .await;
            state.end_scan();
            match out {
                Ok(Err(e)) => warn!(error = %e, "legacy import failed"),
                Err(e) => warn!(error = %e, "legacy import task failed"),
                Ok(Ok(_)) => {}
            }
        });
    }
}

/// After a scan: the one-time legacy import when a legacy library was never
/// imported, otherwise sidecar values for rows nobody curated yet. Personal
/// data (play counts, moods, …) is never re-imported here.
fn post_scan_metadata(db: &crate::db::Db, data_dir: &std::path::Path, root: &std::path::Path) {
    match crate::backup::auto_import_legacy_once(db, data_dir, root) {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(e) => warn!(error = %e, "legacy import after scan failed"),
    }
    match crate::backup::import_sidecar_metadata(db, root) {
        Ok((albums, tracks)) => {
            if albums > 0 || tracks > 0 {
                let _ = db.clear_weak_studio_placeholders();
                info!(
                    album_meta_merged = albums,
                    track_meta_merged = tracks,
                    "applied sidecar metadata after scan"
                );
            }
        }
        Err(e) => warn!(error = %e, "sidecar metadata after scan failed"),
    }
}

/// See [`AppState::try_scan_lease`].
pub struct ScanLease(AppState);

impl Drop for ScanLease {
    fn drop(&mut self) {
        self.0.end_scan();
    }
}
