//! Filesystem watcher on the music root (parity `server/scanner/watcher.mjs`).
//!
//! Events are coalesced: a burst of changes (a download finishing, a folder being
//! deleted) results in a single incremental re-index once the tree goes quiet.

use crate::state::AppState;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{info, warn};

/// Quiet period before a burst of filesystem events triggers a re-index.
const DEBOUNCE: Duration = Duration::from_secs(6);
const POLL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub enabled: bool,
    pub running: bool,
    pub root: Option<String>,
    pub events: u64,
    pub last_event_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub pending: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    watcher: Option<RecommendedWatcher>,
    root: Option<PathBuf>,
    last_event_at: Option<String>,
    last_scan_at: Option<String>,
    error: Option<String>,
}

/// Shared watcher runtime held by `AppState`.
pub struct WatcherRuntime {
    inner: Mutex<Inner>,
    events: AtomicU64,
    pending: AtomicBool,
    /// Monotonic tick of the last event, used for debouncing.
    last_event_ms: AtomicU64,
    running: AtomicBool,
    loop_started: AtomicBool,
}

impl Default for WatcherRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl WatcherRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            events: AtomicU64::new(0),
            pending: AtomicBool::new(false),
            last_event_ms: AtomicU64::new(0),
            running: AtomicBool::new(false),
            loop_started: AtomicBool::new(false),
        }
    }

    pub fn status(&self, enabled: bool) -> WatcherStatus {
        let inner = self.inner.lock().unwrap();
        WatcherStatus {
            enabled,
            running: self.running.load(Ordering::SeqCst),
            root: inner
                .root
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            events: self.events.load(Ordering::SeqCst),
            last_event_at: inner.last_event_at.clone(),
            last_scan_at: inner.last_scan_at.clone(),
            pending: self.pending.load(Ordering::SeqCst),
            error: inner.error.clone(),
        }
    }

    fn note_event(&self) {
        self.events.fetch_add(1, Ordering::Relaxed);
        self.pending.store(true, Ordering::SeqCst);
        self.last_event_ms.store(now_ms(), Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_event_at = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.watcher = None;
        inner.root = None;
        inner.error = None;
        self.running.store(false, Ordering::SeqCst);
        self.pending.store(false, Ordering::SeqCst);
    }
}

fn is_relevant(event: &notify::Event) -> bool {
    use notify::EventKind;
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    ) {
        return false;
    }
    // Ignore our own metadata sidecars and junk folders.
    !event.paths.iter().any(|p| {
        p.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(crate::layout::is_excluded_dir)
        })
    })
}

/// Start (or restart) the watcher for the configured music root.
pub fn start(state: &AppState) {
    let (enabled, root) = {
        let cfg = state.config.lock().unwrap();
        (cfg.watch_library, cfg.music_root.clone())
    };
    if !enabled {
        state.watcher.stop();
        return;
    }
    let Some(root) = root else {
        state.watcher.stop();
        return;
    };
    if !root.is_dir() {
        warn!(path = %root.display(), "watch skipped: music root missing");
        state.watcher.stop();
        return;
    }
    restart_on(state, &root);
    ensure_loop(state);
}

pub fn stop(state: &AppState) {
    state.watcher.stop();
    info!("library watcher stopped");
}

fn restart_on(state: &AppState, root: &Path) {
    let runtime = state.watcher.clone();
    let handler_runtime = runtime.clone();
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => {
                if is_relevant(&event) {
                    handler_runtime.note_event();
                }
            }
            Err(err) => {
                if let Ok(mut inner) = handler_runtime.inner.lock() {
                    inner.error = Some(err.to_string());
                }
            }
        }) {
            Ok(w) => w,
            Err(err) => {
                warn!(error = %err, "could not create filesystem watcher");
                let mut inner = runtime.inner.lock().unwrap();
                inner.error = Some(err.to_string());
                return;
            }
        };

    if let Err(err) = watcher.watch(root, RecursiveMode::Recursive) {
        warn!(error = %err, path = %root.display(), "watch failed");
        let mut inner = runtime.inner.lock().unwrap();
        inner.error = Some(err.to_string());
        return;
    }

    {
        let mut inner = runtime.inner.lock().unwrap();
        inner.watcher = Some(watcher);
        inner.root = Some(root.to_path_buf());
        inner.error = None;
    }
    runtime.running.store(true, Ordering::SeqCst);
    info!(path = %root.display(), "library watcher started");
}

/// Debounce loop: one task per process, kept alive across watcher restarts.
fn ensure_loop(state: &AppState) {
    if state
        .watcher
        .loop_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(POLL).await;
            if !state.watcher.running.load(Ordering::SeqCst) {
                continue;
            }
            if !state.watcher.pending.load(Ordering::SeqCst) {
                continue;
            }
            let elapsed =
                now_ms().saturating_sub(state.watcher.last_event_ms.load(Ordering::SeqCst));
            if elapsed < DEBOUNCE.as_millis() as u64 {
                continue;
            }
            if state.is_scanning() {
                continue;
            }
            state.watcher.pending.store(false, Ordering::SeqCst);
            info!("library changed on disk — incremental re-index");
            match state.run_scan_blocking().await {
                Ok(report) => {
                    if let Ok(mut inner) = state.watcher.inner.lock() {
                        inner.last_scan_at = Some(chrono::Utc::now().to_rfc3339());
                    }
                    info!(
                        indexed = report.indexed_tracks,
                        removed = report.removed_tracks,
                        "watcher re-index done"
                    );
                }
                Err(err) => {
                    warn!(error = %err, "watcher re-index failed");
                    // Retry on the next quiet period.
                    state.watcher.pending.store(true, Ordering::SeqCst);
                    state
                        .watcher
                        .last_event_ms
                        .store(now_ms(), Ordering::SeqCst);
                }
            }
        }
    });
}

pub type SharedWatcher = Arc<WatcherRuntime>;
