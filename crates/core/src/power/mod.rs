//! "Prevent the computer from sleeping" (`settings.json` → `power`).
//!
//! The hub can hold a platform sleep lock (systemd-logind inhibitor on Linux,
//! `SetThreadExecutionState` on Windows, `caffeinate` on macOS) so that a PC
//! reached remotely does not suspend under its users. Only system sleep is
//! blocked: the display may still turn off and lock.
//!
//! Modes ([`PreventSleep`]):
//! - `off` (default): nothing runs, nothing is held.
//! - `always`: the lock is held while the hub serves.
//! - `whenActive`: the lock is held while the hub is in use (a media,
//!   transcode or podcast stream, a scan / job / download, traffic through
//!   the remote-access tunnel) and for a grace period after the last activity.
//!
//! Everything is event driven. Activity sources hold an [`ActivityGuard`] or
//! call [`PowerManager::touch`]; both only update counters and an `Instant`
//! under a mutex. While a `whenActive` lock is held and nothing is running, a
//! single tokio sleep waits for the end of the grace period and is re-armed
//! when it wakes early. With the lock released (or the option off) there is no
//! task, timer or helper process at all.

pub mod api;
mod platform;

use crate::config::{PowerSettings, PreventSleep};
#[cfg(test)]
use crate::sync::LockRecover;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;
use tokio::time::Instant;
use tracing::{info, warn};

/// The platform has no sleep lock the hub can use (no systemd, a container…).
pub const ERR_UNSUPPORTED: &str = "power_unsupported";
/// The platform refused the lock (polkit, permissions).
pub const ERR_REFUSED: &str = "power_refused";
/// The lock could not be taken or ended on its own.
pub const ERR_FAILED: &str = "power_failed";

/// After a failure the lock is not retried on every activity: only after a
/// settings change, or this long after the failure.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

/// Text shown by the platform next to the lock (`systemd-inhibit --list`).
const WHY: &str = "RE-KORD is serving music to other devices";

/// What keeps the hub busy in `whenActive` mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    /// Media, transcode, podcast or preview stream.
    Stream,
    /// Scan, background job, download.
    Job,
    /// A request through the remote-access tunnel.
    Remote,
}

impl ActivityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stream => "stream",
            Self::Job => "job",
            Self::Remote => "remote",
        }
    }
}

/// Why the lock is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Always,
    Active,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Always => "always",
            Self::Active => "active",
        }
    }
}

/// A platform failure: stable code for the clients plus an English detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InhibitError {
    pub code: &'static str,
    pub detail: String,
}

impl InhibitError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// What a backend is asked to hold.
#[derive(Debug, Clone, Copy)]
pub struct InhibitRequest<'a> {
    pub why: &'a str,
    /// Also block the suspend a closed laptop lid triggers (Linux).
    pub lid: bool,
}

/// Which part of a lock ended on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockPart {
    Sleep,
    Lid,
}

/// A held platform lock: dropping it releases it.
pub trait Lock: Send {}

/// What [`Backend::acquire`] took.
pub struct Acquired {
    pub lock: Box<dyn Lock>,
    /// The lid part was requested but could not be taken (sleep still is).
    pub lid_error: Option<InhibitError>,
    /// Extra mechanisms taken next to the main one (e.g. the GNOME session).
    pub extras: Vec<&'static str>,
}

/// Lets a backend report that a lock it handed out ended on its own (the
/// helper process exited, the platform refused it a moment later). Must not
/// be called from inside [`Backend::acquire`].
#[derive(Clone)]
pub struct LostNotifier {
    shared: Weak<Shared>,
    epoch: u64,
}

impl LostNotifier {
    pub fn lost(&self, part: LockPart, err: InhibitError) {
        if let Some(shared) = self.shared.upgrade() {
            shared.on_lost(self.epoch, part, err);
        }
    }
}

/// A platform sleep lock. Tests use a fake one.
pub trait Backend: Send + Sync + 'static {
    /// `None`: no lock exists on this platform.
    fn method(&self) -> Option<&'static str>;
    fn supports_lid(&self) -> bool;
    fn acquire(
        &self,
        req: InhibitRequest<'_>,
        lost: LostNotifier,
    ) -> Result<Acquired, InhibitError>;
}

struct Last {
    at: Instant,
    wall: DateTime<Utc>,
    kind: ActivityKind,
}

struct Hold {
    reason: Reason,
    since: DateTime<Utc>,
    /// The lid part was asked for (to notice a settings change).
    lid_requested: bool,
    lid_held: bool,
    lid_error: Option<InhibitError>,
    extras: Vec<&'static str>,
    epoch: u64,
    _lock: Box<dyn Lock>,
}

struct Failure {
    err: InhibitError,
    at: Instant,
}

struct Inner {
    settings: PowerSettings,
    /// Set once the hub serves; nothing is held before.
    started: bool,
    /// Hub shutting down: nothing is held any more.
    stopped: bool,
    streams: usize,
    jobs: usize,
    last: Option<Last>,
    hold: Option<Hold>,
    epoch: u64,
    /// The grace timer task, while one runs.
    timer: Option<tokio::task::AbortHandle>,
    /// Bumped per timer: a superseded task leaves the state alone.
    timer_gen: u64,
    failure: Option<Failure>,
    data_dir: Option<PathBuf>,
    runtime: Option<tokio::runtime::Handle>,
}

impl Inner {
    fn busy(&self) -> bool {
        self.streams > 0 || self.jobs > 0
    }

    fn grace(&self) -> Duration {
        Duration::from_secs(u64::from(self.settings.grace_minutes) * 60)
    }

    /// End of the grace period (`whenActive`, nothing running).
    fn deadline(&self) -> Option<Instant> {
        self.last.as_ref().map(|l| l.at + self.grace())
    }

    fn wanted(&self, now: Instant) -> Option<Reason> {
        if !self.started || self.stopped {
            return None;
        }
        match self.settings.prevent_sleep {
            PreventSleep::Off => None,
            PreventSleep::Always => Some(Reason::Always),
            PreventSleep::WhenActive => {
                let recent = self.deadline().is_some_and(|d| now < d);
                (self.busy() || recent).then_some(Reason::Active)
            }
        }
    }

    /// When to try the lock again after a failure that may pass (a helper
    /// killed, a transient refusal), while it is still wanted.
    fn retry_at(&self, now: Instant) -> Option<Instant> {
        if self.hold.is_some() || self.wanted(now).is_none() {
            return None;
        }
        self.failure
            .as_ref()
            .filter(|f| f.err.code != ERR_UNSUPPORTED)
            .map(|f| f.at + RETRY_AFTER)
    }

    fn retry_blocked(&self, now: Instant) -> bool {
        self.failure
            .as_ref()
            .is_some_and(|f| f.err.code == ERR_UNSUPPORTED || now < f.at + RETRY_AFTER)
    }
}

/// Transitions logged once the mutex is released.
enum Event {
    Inhibited { reason: Reason, method: String },
    Released,
    Failed(InhibitError),
    LidFailed(InhibitError),
}

struct Shared {
    backend: Box<dyn Backend>,
    /// Fast path for the request middleware: is `whenActive` on?
    when_active: AtomicBool,
    inner: Mutex<Inner>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Bring the held lock in line with the settings and the activity.
    fn reconcile(self: &Arc<Self>, inner: &mut Inner, now: Instant, events: &mut Vec<Event>) {
        let want = inner.wanted(now);
        let lid_wanted = inner.settings.keep_awake_lid_closed && self.backend.supports_lid();
        // The lid option changed: the lock is taken again with (or without)
        // the lid part before the old one goes, so sleep stays blocked and
        // nothing is logged as a transition.
        let mut previous = None;
        if let Some(hold) = &inner.hold {
            if want.is_none() {
                inner.hold = None;
                events.push(Event::Released);
            } else if hold.lid_requested != lid_wanted {
                previous = inner.hold.take();
            }
        }
        if let Some(reason) = want {
            if let Some(hold) = inner.hold.as_mut() {
                hold.reason = reason;
            } else if previous.is_some() || !inner.retry_blocked(now) {
                let since = previous.as_ref().map(|h| h.since);
                self.acquire(inner, reason, lid_wanted, now, since, events);
            }
        }
        drop(previous);
        if inner.settings.prevent_sleep == PreventSleep::WhenActive
            && inner.hold.is_some()
            && !inner.busy()
        {
            self.arm_timer(inner);
        }
        // `always` (or a busy `whenActive`) after a failure: nothing else
        // would ever call reconcile again, so a timer retries the lock.
        if inner.retry_at(now).is_some() {
            self.arm_timer(inner);
        }
    }

    fn acquire(
        self: &Arc<Self>,
        inner: &mut Inner,
        reason: Reason,
        lid: bool,
        now: Instant,
        relock_since: Option<DateTime<Utc>>,
        events: &mut Vec<Event>,
    ) {
        let Some(method) = self.backend.method() else {
            let err = InhibitError::new(ERR_UNSUPPORTED, "no sleep lock on this platform");
            inner.failure = Some(Failure {
                err: err.clone(),
                at: now,
            });
            events.push(Event::Failed(err));
            return;
        };
        inner.epoch = inner.epoch.wrapping_add(1);
        let epoch = inner.epoch;
        let notifier = LostNotifier {
            shared: Arc::downgrade(self),
            epoch,
        };
        // Helper processes and their watchers need the hub's runtime.
        let runtime = inner
            .runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok());
        let _enter = runtime.as_ref().map(|h| h.enter());
        match self
            .backend
            .acquire(InhibitRequest { why: WHY, lid }, notifier)
        {
            Ok(got) => {
                inner.failure = None;
                if let Some(e) = &got.lid_error {
                    events.push(Event::LidFailed(e.clone()));
                }
                let mut label = method.to_string();
                for extra in &got.extras {
                    label.push_str(" + ");
                    label.push_str(extra);
                }
                if relock_since.is_none() {
                    events.push(Event::Inhibited {
                        reason,
                        method: label,
                    });
                }
                inner.hold = Some(Hold {
                    reason,
                    since: relock_since.unwrap_or_else(Utc::now),
                    lid_requested: lid,
                    lid_held: lid && got.lid_error.is_none(),
                    lid_error: got.lid_error,
                    extras: got.extras,
                    epoch,
                    _lock: got.lock,
                });
            }
            Err(err) => {
                inner.failure = Some(Failure {
                    err: err.clone(),
                    at: now,
                });
                if relock_since.is_some() {
                    events.push(Event::Released);
                }
                events.push(Event::Failed(err));
            }
        }
    }

    /// One tokio sleep until the end of the grace period, re-armed while the
    /// deadline moves; it ends as soon as the lock is released or work starts.
    fn arm_timer(self: &Arc<Self>, inner: &mut Inner) {
        if inner.timer.is_some() {
            return;
        }
        let Some(handle) = inner
            .runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
        else {
            warn!("sleep prevention: no runtime for the grace timer");
            return;
        };
        inner.timer_gen = inner.timer_gen.wrapping_add(1);
        let generation = inner.timer_gen;
        let weak = Arc::downgrade(self);
        let task = handle.spawn(async move {
            loop {
                let next = {
                    let Some(shared) = weak.upgrade() else { return };
                    let mut events = Vec::new();
                    let next = {
                        let mut inner = shared.lock();
                        shared.timer_tick(&mut inner, generation, &mut events)
                    };
                    shared.emit(events);
                    next
                };
                match next {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => return,
                }
            }
        });
        inner.timer = Some(task.abort_handle());
    }

    /// Stop the grace timer (a settings change re-arms it with the new grace).
    fn cancel_timer(inner: &mut Inner) {
        if let Some(task) = inner.timer.take() {
            task.abort();
        }
    }

    /// The timer's step: release when the grace period is over, else say when
    /// to wake next. `None` ends the timer (and lets the next activity arm one).
    fn timer_tick(
        self: &Arc<Self>,
        inner: &mut Inner,
        generation: u64,
        events: &mut Vec<Event>,
    ) -> Option<Instant> {
        if inner.timer_gen != generation {
            return None;
        }
        let now = Instant::now();
        // `timer` stays set: reconcile must not spawn a second timer.
        self.reconcile(inner, now, events);
        let keep = inner.settings.prevent_sleep == PreventSleep::WhenActive
            && inner.hold.is_some()
            && !inner.busy();
        match inner
            .deadline()
            .filter(|_| keep)
            .or_else(|| inner.retry_at(now))
        {
            Some(deadline) => Some(deadline.max(now)),
            None => {
                inner.timer = None;
                None
            }
        }
    }

    fn on_lost(self: &Arc<Self>, epoch: u64, part: LockPart, err: InhibitError) {
        let mut events = Vec::new();
        {
            let mut inner = self.lock();
            let Some(hold) = inner.hold.as_mut().filter(|h| h.epoch == epoch) else {
                return;
            };
            match part {
                LockPart::Lid => {
                    hold.lid_held = false;
                    hold.lid_error = Some(err.clone());
                    events.push(Event::LidFailed(err));
                }
                LockPart::Sleep => {
                    let now = Instant::now();
                    inner.hold = None;
                    inner.failure = Some(Failure {
                        err: err.clone(),
                        at: now,
                    });
                    events.push(Event::Failed(err));
                    // Arms the retry timer (the lock is not retried at once).
                    self.reconcile(&mut inner, now, &mut events);
                }
            }
        }
        self.emit(events);
    }

    /// Log transitions (info, once each) and write the activity log.
    fn emit(&self, events: Vec<Event>) {
        if events.is_empty() {
            return;
        }
        let data_dir = self.lock().data_dir.clone();
        for ev in events {
            let entry = match &ev {
                Event::Inhibited { reason, method } => {
                    info!(reason = reason.as_str(), %method, "sleep prevention: system sleep blocked");
                    crate::diagnostics::ActivityEvent::new(
                        "power",
                        "inhibited",
                        format!("system sleep blocked ({})", reason.as_str()),
                    )
                    .params(serde_json::json!({ "reason": reason.as_str() }))
                }
                Event::Released => {
                    info!("sleep prevention: system sleep allowed again");
                    crate::diagnostics::ActivityEvent::new(
                        "power",
                        "released",
                        "system sleep allowed again",
                    )
                }
                Event::Failed(e) => {
                    warn!(code = e.code, detail = %e.detail, "sleep prevention: lock not available");
                    crate::diagnostics::ActivityEvent::new(
                        "power",
                        "failed",
                        format!("sleep lock not available: {}", e.detail),
                    )
                    .params(serde_json::json!({ "code": e.code }))
                }
                Event::LidFailed(e) => {
                    warn!(code = e.code, detail = %e.detail, "sleep prevention: lid lock not available");
                    continue;
                }
            };
            if let Some(dir) = &data_dir {
                crate::diagnostics::log_activity(dir, entry);
            }
        }
    }
}

/// Live status for the admin API.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub inhibiting: bool,
    /// `always` / `active` while inhibiting.
    pub reason: Option<&'static str>,
    pub since: Option<String>,
    pub last_activity: Option<String>,
    pub last_activity_kind: Option<&'static str>,
    pub active_streams: usize,
    pub active_jobs: usize,
    /// `whenActive` with nothing running: when the grace period ends.
    pub release_at: Option<String>,
    /// Platform method in use (or that would be used).
    pub method: Option<String>,
    pub supported: bool,
    pub lid_supported: bool,
    pub lid_inhibited: bool,
    pub error_code: Option<&'static str>,
    pub error: Option<String>,
    pub lid_error_code: Option<&'static str>,
    pub lid_error: Option<String>,
}

fn rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Holds an activity open (`whenActive`); dropping it marks its end.
#[must_use = "the activity ends when the guard is dropped"]
pub struct ActivityGuard {
    shared: Arc<Shared>,
    kind: ActivityKind,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut events = Vec::new();
        {
            let mut inner = self.shared.lock();
            match self.kind {
                ActivityKind::Job => inner.jobs = inner.jobs.saturating_sub(1),
                _ => inner.streams = inner.streams.saturating_sub(1),
            }
            let now = Instant::now();
            inner.last = Some(Last {
                at: now,
                wall: Utc::now(),
                kind: self.kind,
            });
            if inner.settings.prevent_sleep == PreventSleep::WhenActive {
                self.shared.reconcile(&mut inner, now, &mut events);
            }
        }
        self.shared.emit(events);
    }
}

/// Sleep prevention runtime of a hub (cheap to clone).
#[derive(Clone)]
pub struct PowerManager {
    shared: Arc<Shared>,
}

impl PowerManager {
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self {
            shared: Arc::new(Shared {
                backend,
                when_active: AtomicBool::new(false),
                inner: Mutex::new(Inner {
                    settings: PowerSettings::default(),
                    started: false,
                    stopped: false,
                    streams: 0,
                    jobs: 0,
                    last: None,
                    hold: None,
                    epoch: 0,
                    timer: None,
                    timer_gen: 0,
                    failure: None,
                    data_dir: None,
                    runtime: None,
                }),
            }),
        }
    }

    /// The lock of the platform the hub runs on.
    pub fn for_platform() -> Self {
        Self::new(platform::backend())
    }

    fn with_inner<R>(&self, f: impl FnOnce(&Arc<Shared>, &mut Inner, &mut Vec<Event>) -> R) -> R {
        let mut events = Vec::new();
        let out = {
            let mut inner = self.shared.lock();
            f(&self.shared, &mut inner, &mut events)
        };
        self.shared.emit(events);
        out
    }

    /// Apply new settings now (no restart). A change clears a past failure,
    /// so the lock is tried again.
    pub fn configure(&self, settings: PowerSettings) {
        let settings = settings.clamped();
        self.shared.when_active.store(
            settings.prevent_sleep == PreventSleep::WhenActive,
            Ordering::SeqCst,
        );
        self.with_inner(|shared, inner, events| {
            if inner.settings != settings {
                inner.failure = None;
                Shared::cancel_timer(inner);
            }
            inner.settings = settings;
            shared.reconcile(inner, Instant::now(), events);
        });
    }

    /// The hub serves: from now on the lock may be held. Call it inside the
    /// hub's runtime (its handle runs the helpers and the grace timer).
    /// Transitions go to `<data_dir>/activity.jsonl` (none without a dir).
    pub fn start(&self, data_dir: Option<PathBuf>) {
        self.with_inner(|shared, inner, events| {
            inner.started = true;
            inner.stopped = false;
            inner.data_dir = data_dir;
            inner.runtime = tokio::runtime::Handle::try_current().ok();
            shared.reconcile(inner, Instant::now(), events);
        });
    }

    /// Hub shutdown: release the lock and take no new one.
    pub fn shutdown(&self) {
        self.with_inner(|shared, inner, events| {
            inner.stopped = true;
            Shared::cancel_timer(inner);
            shared.reconcile(inner, Instant::now(), events);
        });
    }

    /// True while `whenActive` is on (one atomic load).
    pub fn when_active(&self) -> bool {
        self.shared.when_active.load(Ordering::Relaxed)
    }

    /// Open an activity (stream, job). Counted in every mode, so switching
    /// to `whenActive` sees work already running.
    pub fn begin(&self, kind: ActivityKind) -> ActivityGuard {
        self.with_inner(|shared, inner, events| {
            match kind {
                ActivityKind::Job => inner.jobs += 1,
                _ => inner.streams += 1,
            }
            if inner.settings.prevent_sleep == PreventSleep::WhenActive {
                let now = Instant::now();
                inner.last = Some(Last {
                    at: now,
                    wall: Utc::now(),
                    kind,
                });
                shared.reconcile(inner, now, events);
            }
        });
        ActivityGuard {
            shared: self.shared.clone(),
            kind,
        }
    }

    /// A one-off activity (a tunnel request). No-op unless `whenActive`.
    pub fn touch(&self, kind: ActivityKind) {
        if !self.when_active() {
            return;
        }
        self.with_inner(|shared, inner, events| {
            let now = Instant::now();
            inner.last = Some(Last {
                at: now,
                wall: Utc::now(),
                kind,
            });
            shared.reconcile(inner, now, events);
        });
    }

    pub fn settings(&self) -> PowerSettings {
        self.shared.lock().settings
    }

    pub fn status(&self) -> PowerStatus {
        let backend = &self.shared.backend;
        let inner = self.shared.lock();
        let hold = inner.hold.as_ref();
        let idle_when_active = inner.settings.prevent_sleep == PreventSleep::WhenActive
            && hold.is_some()
            && !inner.busy();
        let release_at = inner
            .last
            .as_ref()
            .filter(|_| idle_when_active)
            .and_then(|l| {
                chrono::Duration::from_std(inner.grace())
                    .ok()
                    .map(|g| l.wall + g)
            })
            .map(rfc3339);
        let method = backend.method().map(|m| {
            let mut label = m.to_string();
            for extra in hold.map(|h| h.extras.as_slice()).unwrap_or_default() {
                label.push_str(" + ");
                label.push_str(extra);
            }
            label
        });
        let lid_error = hold.and_then(|h| h.lid_error.as_ref());
        PowerStatus {
            inhibiting: hold.is_some(),
            reason: hold.map(|h| h.reason.as_str()),
            since: hold.map(|h| rfc3339(h.since)),
            last_activity: inner.last.as_ref().map(|l| rfc3339(l.wall)),
            last_activity_kind: inner.last.as_ref().map(|l| l.kind.as_str()),
            active_streams: inner.streams,
            active_jobs: inner.jobs,
            release_at,
            method,
            supported: backend.method().is_some(),
            lid_supported: backend.supports_lid(),
            lid_inhibited: hold.is_some_and(|h| h.lid_held),
            error_code: inner.failure.as_ref().map(|f| f.err.code),
            error: inner.failure.as_ref().map(|f| f.err.detail.clone()),
            lid_error_code: lid_error.map(|e| e.code),
            lid_error: lid_error.map(|e| e.detail.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Counts locks instead of touching the system.
    #[derive(Default)]
    struct FakeState {
        held: AtomicUsize,
        acquired: AtomicUsize,
        lid_held: AtomicUsize,
        fail: Mutex<Option<InhibitError>>,
        notifier: Mutex<Option<LostNotifier>>,
    }

    struct FakeBackend(Arc<FakeState>);

    struct FakeLock {
        state: Arc<FakeState>,
        lid: bool,
    }

    impl Lock for FakeLock {}

    impl Drop for FakeLock {
        fn drop(&mut self) {
            self.state.held.fetch_sub(1, Ordering::SeqCst);
            if self.lid {
                self.state.lid_held.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    impl Backend for FakeBackend {
        fn method(&self) -> Option<&'static str> {
            Some("fake")
        }
        fn supports_lid(&self) -> bool {
            true
        }
        fn acquire(
            &self,
            req: InhibitRequest<'_>,
            lost: LostNotifier,
        ) -> Result<Acquired, InhibitError> {
            if let Some(e) = self.0.fail.lock_or_recover().clone() {
                return Err(e);
            }
            self.0.held.fetch_add(1, Ordering::SeqCst);
            self.0.acquired.fetch_add(1, Ordering::SeqCst);
            if req.lid {
                self.0.lid_held.fetch_add(1, Ordering::SeqCst);
            }
            *self.0.notifier.lock_or_recover() = Some(lost);
            Ok(Acquired {
                lock: Box::new(FakeLock {
                    state: self.0.clone(),
                    lid: req.lid,
                }),
                lid_error: None,
                extras: Vec::new(),
            })
        }
    }

    fn manager() -> (PowerManager, Arc<FakeState>) {
        let state = Arc::new(FakeState::default());
        let pm = PowerManager::new(Box::new(FakeBackend(state.clone())));
        (pm, state)
    }

    fn settings(mode: PreventSleep, grace: u32) -> PowerSettings {
        PowerSettings {
            prevent_sleep: mode,
            grace_minutes: grace,
            keep_awake_lid_closed: false,
        }
    }

    fn started(mode: PreventSleep, grace: u32) -> (PowerManager, Arc<FakeState>) {
        let (pm, st) = manager();
        pm.configure(settings(mode, grace));
        pm.start(None);
        (pm, st)
    }

    fn held(st: &FakeState) -> usize {
        st.held.load(Ordering::SeqCst)
    }

    /// Let spawned timer tasks run.
    async fn settle() {
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn off_holds_nothing_and_counts_activity_only() {
        let (pm, st) = started(PreventSleep::Off, 10);
        let g = pm.begin(ActivityKind::Stream);
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 0);
        assert_eq!(pm.status().active_streams, 1);
        drop(g);
        assert_eq!(held(&st), 0);
        assert!(!pm.status().inhibiting);
        assert_eq!(st.acquired.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_held_before_the_hub_serves() {
        let (pm, st) = manager();
        pm.configure(settings(PreventSleep::Always, 10));
        assert_eq!(held(&st), 0);
        pm.start(None);
        assert_eq!(held(&st), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn always_holds_until_off_or_shutdown() {
        let (pm, st) = started(PreventSleep::Always, 10);
        assert_eq!(held(&st), 1);
        let s = pm.status();
        assert!(s.inhibiting);
        assert_eq!(s.reason, Some("always"));
        assert!(s.since.is_some());
        // Activity changes nothing, and no timer releases it.
        drop(pm.begin(ActivityKind::Stream));
        tokio::time::advance(Duration::from_secs(3 * 3600)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        assert_eq!(st.acquired.load(Ordering::SeqCst), 1);

        pm.configure(settings(PreventSleep::Off, 10));
        assert_eq!(held(&st), 0);
        assert!(!pm.status().inhibiting);

        pm.configure(settings(PreventSleep::Always, 10));
        assert_eq!(held(&st), 1);
        pm.shutdown();
        assert_eq!(held(&st), 0);
        // After shutdown nothing is taken again.
        pm.configure(settings(PreventSleep::Always, 5));
        assert_eq!(held(&st), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn when_active_holds_during_activity_and_grace() {
        let (pm, st) = started(PreventSleep::WhenActive, 1);
        assert_eq!(held(&st), 0, "idle hub holds nothing");

        let g = pm.begin(ActivityKind::Stream);
        assert_eq!(held(&st), 1);
        assert_eq!(pm.status().reason, Some("active"));
        // A long stream outlives the grace period without a release.
        tokio::time::advance(Duration::from_secs(10 * 60)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        assert!(pm.status().release_at.is_none());

        drop(g);
        assert_eq!(held(&st), 1, "grace period after the last activity");
        assert!(pm.status().release_at.is_some());
        tokio::time::advance(Duration::from_secs(59)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        tokio::time::advance(Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(held(&st), 0, "released when the grace period ends");
        let s = pm.status();
        assert!(!s.inhibiting);
        assert_eq!(s.last_activity_kind, Some("stream"));
        assert!(s.last_activity.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn activity_refreshes_the_deadline() {
        let (pm, st) = started(PreventSleep::WhenActive, 2);
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 1);
        tokio::time::advance(Duration::from_secs(100)).await;
        settle().await;
        pm.touch(ActivityKind::Remote);
        // 100 s + 100 s: past the first deadline, inside the second.
        tokio::time::advance(Duration::from_secs(100)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        tokio::time::advance(Duration::from_secs(21)).await;
        settle().await;
        assert_eq!(held(&st), 0);
        assert_eq!(
            st.acquired.load(Ordering::SeqCst),
            1,
            "one lock, no flapping"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn jobs_keep_it_awake_and_overlap_with_streams() {
        let (pm, st) = started(PreventSleep::WhenActive, 1);
        let job = pm.begin(ActivityKind::Job);
        let stream = pm.begin(ActivityKind::Stream);
        drop(stream);
        tokio::time::advance(Duration::from_secs(5 * 60)).await;
        settle().await;
        assert_eq!(held(&st), 1, "the job is still running");
        assert_eq!(pm.status().active_jobs, 1);
        drop(job);
        tokio::time::advance(Duration::from_secs(61)).await;
        settle().await;
        assert_eq!(held(&st), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn touch_is_ignored_unless_when_active() {
        let (pm, st) = started(PreventSleep::Off, 1);
        pm.touch(ActivityKind::Remote);
        assert!(pm.status().last_activity.is_none());
        assert_eq!(held(&st), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn settings_change_while_inhibiting() {
        let (pm, st) = started(PreventSleep::WhenActive, 10);
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 1);

        // Shorter grace: the running timer picks up the new deadline.
        pm.configure(settings(PreventSleep::WhenActive, 1));
        tokio::time::advance(Duration::from_secs(61)).await;
        settle().await;
        assert_eq!(held(&st), 0);

        // whenActive → always keeps (and relabels) the same lock.
        pm.touch(ActivityKind::Remote);
        pm.configure(settings(PreventSleep::Always, 1));
        assert_eq!(held(&st), 1);
        assert_eq!(pm.status().reason, Some("always"));
        tokio::time::advance(Duration::from_secs(3600)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        assert_eq!(st.acquired.load(Ordering::SeqCst), 2);

        // always → whenActive with recent activity: kept for the grace period.
        pm.touch(ActivityKind::Remote); // ignored: not whenActive yet
        pm.configure(settings(PreventSleep::WhenActive, 1));
        assert_eq!(held(&st), 0, "last activity is an hour old");

        // Lid on: the lock is taken again with the lid part.
        pm.configure(PowerSettings {
            keep_awake_lid_closed: true,
            ..settings(PreventSleep::Always, 1)
        });
        assert_eq!(held(&st), 1);
        assert_eq!(st.lid_held.load(Ordering::SeqCst), 1);
        assert!(pm.status().lid_inhibited);
        let since = pm.status().since;
        pm.configure(settings(PreventSleep::Always, 1));
        assert_eq!(held(&st), 1);
        assert_eq!(st.lid_held.load(Ordering::SeqCst), 0);
        assert!(!pm.status().lid_inhibited);
        assert_eq!(pm.status().since, since, "a lid change is not a new lock");
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_releases_a_when_active_lock() {
        let (pm, st) = started(PreventSleep::WhenActive, 10);
        let g = pm.begin(ActivityKind::Job);
        assert_eq!(held(&st), 1);
        pm.shutdown();
        assert_eq!(held(&st), 0);
        drop(g);
        assert_eq!(held(&st), 0, "no new lock while shutting down");
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_manager_releases_the_lock() {
        let (pm, st) = started(PreventSleep::WhenActive, 1);
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 1);
        drop(pm);
        settle().await;
        assert_eq!(held(&st), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn failures_are_reported_and_not_retried_on_every_activity() {
        let (pm, st) = manager();
        *st.fail.lock_or_recover() = Some(InhibitError::new(ERR_REFUSED, "Access denied"));
        pm.configure(settings(PreventSleep::WhenActive, 1));
        pm.start(None);
        pm.touch(ActivityKind::Remote);
        let s = pm.status();
        assert!(!s.inhibiting);
        assert_eq!(s.error_code, Some(ERR_REFUSED));

        *st.fail.lock_or_recover() = None;
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 0, "no retry right after a failure");
        tokio::time::advance(RETRY_AFTER).await;
        pm.touch(ActivityKind::Remote);
        assert_eq!(held(&st), 1, "retried later");
        assert_eq!(pm.status().error_code, None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_settings_change_retries_after_a_failure() {
        let (pm, st) = manager();
        *st.fail.lock_or_recover() = Some(InhibitError::new(ERR_UNSUPPORTED, "no systemd"));
        pm.configure(settings(PreventSleep::Always, 10));
        pm.start(None);
        assert_eq!(pm.status().error_code, Some(ERR_UNSUPPORTED));
        *st.fail.lock_or_recover() = None;
        pm.configure(settings(PreventSleep::Always, 10));
        assert_eq!(held(&st), 0, "same settings: unsupported stays");
        pm.configure(settings(PreventSleep::Always, 11));
        assert_eq!(held(&st), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_lock_lost_later_is_reported() {
        let (pm, st) = started(PreventSleep::Always, 10);
        assert_eq!(held(&st), 1);
        let notifier = st.notifier.lock_or_recover().clone().unwrap();
        notifier.lost(LockPart::Lid, InhibitError::new(ERR_REFUSED, "lid denied"));
        let s = pm.status();
        assert!(s.inhibiting);
        assert_eq!(s.lid_error_code, Some(ERR_REFUSED));
        notifier.lost(
            LockPart::Sleep,
            InhibitError::new(ERR_FAILED, "helper exited"),
        );
        let s = pm.status();
        assert!(!s.inhibiting);
        assert_eq!(s.error_code, Some(ERR_FAILED));
        assert_eq!(held(&st), 0);
        // A stale notifier (older lock) is ignored.
        pm.configure(settings(PreventSleep::Always, 9));
        assert_eq!(held(&st), 1);
        notifier.lost(LockPart::Sleep, InhibitError::new(ERR_FAILED, "old"));
        assert!(pm.status().inhibiting);
    }

    #[tokio::test(start_paused = true)]
    async fn always_takes_the_lock_again_after_losing_it() {
        let (pm, st) = started(PreventSleep::Always, 10);
        let notifier = st.notifier.lock_or_recover().clone().unwrap();
        notifier.lost(LockPart::Sleep, InhibitError::new(ERR_FAILED, "killed"));
        assert_eq!(held(&st), 0);
        settle().await;
        assert_eq!(held(&st), 0, "not retried at once");
        tokio::time::advance(RETRY_AFTER + Duration::from_secs(1)).await;
        settle().await;
        assert_eq!(held(&st), 1, "retried after RETRY_AFTER");
        assert_eq!(st.acquired.load(Ordering::SeqCst), 2);
        assert_eq!(pm.status().error_code, None);
    }

    #[tokio::test(start_paused = true)]
    async fn always_retries_a_failed_first_lock() {
        let (pm, st) = manager();
        *st.fail.lock_or_recover() = Some(InhibitError::new(ERR_FAILED, "transient"));
        pm.configure(settings(PreventSleep::Always, 10));
        pm.start(None);
        assert_eq!(held(&st), 0);
        *st.fail.lock_or_recover() = None;
        tokio::time::advance(RETRY_AFTER + Duration::from_secs(1)).await;
        settle().await;
        assert_eq!(held(&st), 1);
        // Unsupported is final: no timer keeps waking up for it.
        let (pm2, st2) = manager();
        *st2.fail.lock_or_recover() = Some(InhibitError::new(ERR_UNSUPPORTED, "no"));
        pm2.configure(settings(PreventSleep::Always, 10));
        pm2.start(None);
        assert!(pm2.shared.lock().timer.is_none());
        drop(pm);
    }

    #[test]
    fn settings_parse_leniently() {
        let v = serde_json::json!({ "preventSleep": "whenActive", "graceMinutes": 500 });
        let s = PowerSettings::from_json(&v);
        assert_eq!(s.prevent_sleep, PreventSleep::WhenActive);
        assert_eq!(s.grace_minutes, PowerSettings::MAX_GRACE_MINUTES);
        assert!(!s.keep_awake_lid_closed);
        let bad = serde_json::json!({ "preventSleep": 3, "graceMinutes": "x", "keepAwakeLidClosed": true });
        let s = PowerSettings::from_json(&bad);
        assert_eq!(s.prevent_sleep, PreventSleep::Off);
        assert_eq!(s.grace_minutes, PowerSettings::DEFAULT_GRACE_MINUTES);
        assert!(s.keep_awake_lid_closed);
        assert_eq!(
            PreventSleep::parse("when-active"),
            Some(PreventSleep::WhenActive)
        );
        assert_eq!(PreventSleep::parse("Always"), Some(PreventSleep::Always));
        assert_eq!(PreventSleep::parse("0"), Some(PreventSleep::Off));
        assert_eq!(PreventSleep::parse("sometimes"), None);
        assert_eq!(
            serde_json::to_value(settings(PreventSleep::WhenActive, 5)).unwrap(),
            serde_json::json!({ "preventSleep": "whenActive", "graceMinutes": 5, "keepAwakeLidClosed": false })
        );
    }
}
