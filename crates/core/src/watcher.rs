//! Filesystem watcher on the music root (parity `server/scanner/watcher.mjs`).
//!
//! Events are coalesced: a burst of changes (a download finishing, a folder being
//! deleted) results in a single incremental re-index once the tree goes quiet.

use crate::state::AppState;
use crate::sync::LockRecover;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};
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

    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self, enabled: bool) -> WatcherStatus {
        let inner = self.lock_inner();
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
        let mut inner = self.lock_inner();
        inner.watcher = None;
        inner.root = None;
        inner.error = None;
        self.running.store(false, Ordering::SeqCst);
        self.pending.store(false, Ordering::SeqCst);
    }
}

/// How long a file the hub wrote in the music folders is remembered: far
/// longer than event delivery takes, short enough to keep the table tiny.
const OWN_CHANGE_TTL: Duration = Duration::from_secs(60);

/// What the hub itself did to a file in the music folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnState {
    /// Write in progress: its events can arrive before it completes.
    Writing,
    /// Written: ours while the file keeps the size and mtime the hub left.
    Written { len: u64, mtime: Option<SystemTime> },
    /// Removed: ours while the file stays gone.
    Removed,
}

struct OwnChange {
    at: Instant,
    state: OwnState,
}

fn own_changes() -> &'static Mutex<HashMap<PathBuf, OwnChange>> {
    static OWN: OnceLock<Mutex<HashMap<PathBuf, OwnChange>>> = OnceLock::new();
    OWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_own() -> MutexGuard<'static, HashMap<PathBuf, OwnChange>> {
    own_changes().lock().unwrap_or_else(PoisonError::into_inner)
}

/// Canonical parent + file name: the watcher reports paths under the root
/// as configured, writers may reach the same file through another spelling.
fn own_key(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => dir
            .canonicalize()
            .map(|d| d.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

fn note_own(path: &Path, state: OwnState) {
    let key = own_key(path);
    let now = Instant::now();
    let mut map = lock_own();
    map.retain(|_, c| now.duration_since(c.at) < OWN_CHANGE_TTL);
    map.insert(key, OwnChange { at: now, state });
}

/// Write a file inside the music folders on behalf of the hub (Studio cover,
/// artist image, sidecar) without the watcher scheduling a re-index for it.
/// A later change by anyone else (different size or mtime) still counts.
pub fn own_write<T, E>(path: &Path, write: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    note_own(path, OwnState::Writing);
    let res = write();
    match (&res, std::fs::metadata(path)) {
        (Ok(_), Ok(meta)) => note_own(
            path,
            OwnState::Written {
                len: meta.len(),
                mtime: meta.modified().ok(),
            },
        ),
        _ => {
            lock_own().remove(&own_key(path));
        }
    }
    res
}

/// Remove a file inside the music folders on behalf of the hub (e.g. the
/// `folder.jpg` a new Studio cover replaces), without a re-index for it.
pub fn own_remove(path: &Path) -> std::io::Result<()> {
    note_own(path, OwnState::Removed);
    let res = std::fs::remove_file(path);
    if res.is_err() {
        lock_own().remove(&own_key(path));
    }
    res
}

/// Whether the current state of `path` is the one the hub itself left.
fn is_own_change(path: &Path) -> bool {
    // Fast path for the common case (no recent hub write): no syscalls.
    if lock_own().is_empty() {
        return false;
    }
    let key = own_key(path);
    let state = {
        let mut map = lock_own();
        let now = Instant::now();
        map.retain(|_, c| now.duration_since(c.at) < OWN_CHANGE_TTL);
        match map.get(&key) {
            Some(c) => c.state,
            None => return false,
        }
    };
    match state {
        OwnState::Writing => true,
        OwnState::Written { len, mtime } => {
            std::fs::metadata(path).is_ok_and(|m| m.len() == len && m.modified().ok() == mtime)
        }
        OwnState::Removed => !path.exists(),
    }
}

/// A path whose changes can never alter the index: junk/hidden folders and
/// files (temp files of atomic writes start with '.'), RE-KORD's own
/// sidecars (the scan never reads them), or a file as the hub just left it.
fn is_ignored_path(path: &Path) -> bool {
    let excluded = path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(crate::layout::is_excluded_dir)
    });
    excluded
        || path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(crate::metadata::sidecar::is_sidecar_name)
        || is_own_change(path)
}

fn is_relevant(event: &notify::Event) -> bool {
    use notify::EventKind;
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    ) {
        return false;
    }
    // No path at all: be safe and re-index.
    event.paths.is_empty() || event.paths.iter().any(|p| !is_ignored_path(p))
}

/// Start (or restart) the watcher for the configured music root.
pub fn start(state: &AppState) {
    let (enabled, root) = {
        let cfg = state.config.lock_or_recover();
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
                let mut inner = runtime.lock_inner();
                inner.error = Some(err.to_string());
                return;
            }
        };

    if let Err(err) = watcher.watch(root, RecursiveMode::Recursive) {
        warn!(error = %err, path = %root.display(), "watch failed");
        let mut inner = runtime.lock_inner();
        inner.error = Some(err.to_string());
        return;
    }

    {
        let mut inner = runtime.lock_inner();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::sidecar;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
    use notify::{Event, EventKind};
    use std::fs;
    use std::sync::mpsc;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rekord-watch-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(dir.join("Artist/Album")).unwrap();
        dir
    }

    fn ev(kind: EventKind, paths: &[&Path]) -> Event {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(p.to_path_buf());
        }
        e
    }

    #[test]
    fn sidecars_and_hidden_temp_files_are_ignored() {
        let album = Path::new("/music/Artist/Album");
        let modify = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        for name in [
            "kord-trackinfo.json",
            "kord-albuminfo.json",
            "kord-artistinfo.json",
            "kord-artistinfo.jpg",
            "wpp-trackinfo.json",
        ] {
            assert!(!is_relevant(&ev(modify, &[&album.join(name)])), "{name}");
        }
        let tmp = album.join(".kord-trackinfo.json.abc.tmp");
        let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(!is_relevant(&ev(
            both,
            &[&tmp, &album.join("kord-trackinfo.json")]
        )));
        // Real library files still count.
        assert!(is_relevant(&ev(modify, &[&album.join("01 Song.flac")])));
        assert!(is_relevant(&ev(modify, &[&album.join("cover.jpg")])));
        assert!(is_relevant(&ev(
            EventKind::Remove(RemoveKind::Folder),
            &[album]
        )));
        // A rename out of a hidden name into a real one is a real change.
        assert!(is_relevant(&ev(
            both,
            &[&album.join(".x.mp3"), &album.join("x.mp3")]
        )));
    }

    #[test]
    fn own_cover_write_is_ignored_but_a_later_user_edit_is_not() {
        let root = tmp_root("own");
        let cover = root.join("Artist/Album/cover.jpg");
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Content));
        own_write(&cover, || sidecar::write_atomic(&cover, &[1u8; 128])).unwrap();
        assert!(!is_relevant(&ev(data, &[&cover])));
        // The user replaces it: different size → relevant.
        fs::write(&cover, [2u8; 64]).unwrap();
        assert!(is_relevant(&ev(data, &[&cover])));

        // Removal by the hub is ignored while the file stays gone…
        let folder = root.join("Artist/Album/folder.jpg");
        fs::write(&folder, [3u8; 64]).unwrap();
        own_remove(&folder).unwrap();
        let removed = EventKind::Remove(RemoveKind::File);
        assert!(!is_relevant(&ev(removed, &[&folder])));
        // …and a user putting one back is seen.
        fs::write(&folder, [4u8; 64]).unwrap();
        assert!(is_relevant(&ev(
            EventKind::Create(CreateKind::File),
            &[&folder]
        )));
        let _ = fs::remove_dir_all(&root);
    }

    /// End to end on the real backend: the hub's own writes produce no
    /// relevant event, a user's file does.
    #[test]
    fn real_watcher_ignores_hub_writes() {
        let root = tmp_root("real");
        let album = root.join("Artist/Album");
        let (tx, rx) = mpsc::channel::<bool>();
        let mut w = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(e) = res {
                let _ = tx.send(is_relevant(&e));
            }
        })
        .unwrap();
        w.watch(&root, RecursiveMode::Recursive).unwrap();

        // Metadata save + Studio cover (through the same paths the API uses).
        sidecar::write_json_atomic(
            &album.join(sidecar::FILE_TRACK),
            &serde_json::json!({"a": 1}),
        )
        .unwrap();
        let cover = album.join("cover.jpg");
        own_write(&cover, || sidecar::write_atomic(&cover, &[9u8; 256])).unwrap();
        let deadline = Instant::now() + Duration::from_millis(1500);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(relevant) => assert!(!relevant, "hub write scheduled a re-index"),
                Err(_) => break,
            }
        }

        // A track added by the user is picked up.
        fs::write(album.join("02 New.mp3"), b"id3").unwrap();
        let seen = (0..50).any(|_| rx.recv_timeout(Duration::from_millis(100)) == Ok(true));
        assert!(seen, "user change missed");
        drop(w);
        let _ = fs::remove_dir_all(&root);
    }
}
