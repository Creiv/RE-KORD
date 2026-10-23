//! Studio download jobs: one yt-dlp run per `downloadId`, observable by any
//! number of NDJSON streams.
//!
//! - The stream that started a job owns it: when every attached stream is gone
//!   (client closed the tab / navigated away and aborted the fetch) yt-dlp is
//!   killed, like legacy `downloadRoutes.mjs`, unless the job was started with
//!   `background: true`.
//! - `GET /api/v1/download/active` lists running and recently finished jobs
//!   (progress, log tail, whether it can be cancelled); with
//!   `?downloadId=…&stream=1` it re-attaches an NDJSON stream (a `snapshot`
//!   event, then live events, ending with `done`).
//! - On success only, the output folder is re-indexed before `done` is sent,
//!   so `done.indexEpoch` already covers the new files.

use crate::download_tags;
use crate::state::AppState;
use crate::sync::LockRecover;
use crate::ytdlp::{self, DownloadExtras, DownloadOutcome, Toolchain};
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

/// Finished jobs stay listed this long (a client coming back sees the result).
const FINISHED_RETENTION: Duration = Duration::from_secs(15 * 60);
/// Log lines kept for `logTail`.
const LOG_TAIL_LINES: usize = 80;
const EVENT_BUFFER: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Running,
    Indexing,
    Done,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Indexing => "indexing",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// One broadcast NDJSON line.
#[derive(Debug)]
struct Event {
    done: bool,
    line: String,
}

struct JobInner {
    status: JobStatus,
    progress: Option<(u32, u32)>,
    log_tail: VecDeque<String>,
    /// Latest snapshot of each item, keyed by id or position.
    items: Vec<Value>,
    cancel_reason: Option<&'static str>,
    done: Option<Value>,
    finished_at: Option<Instant>,
    finished_at_rfc: Option<String>,
}

pub struct DownloadJob {
    pub id: String,
    /// Hub that owns the job (its data dir).
    hub: PathBuf,
    pub kind: String,
    pub output_dir: String,
    pub account_id: String,
    pub background: bool,
    pub started_at: String,
    pub cancel: Arc<AtomicBool>,
    events: broadcast::Sender<Arc<Event>>,
    subscribers: AtomicUsize,
    inner: Mutex<JobInner>,
}

impl DownloadJob {
    fn lock(&self) -> std::sync::MutexGuard<'_, JobInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> JobStatus {
        self.lock().status
    }

    /// Stop yt-dlp; the first reason wins.
    pub fn request_cancel(&self, reason: &'static str) {
        {
            let mut inner = self.lock();
            if inner.status != JobStatus::Running {
                return;
            }
            inner.cancel_reason.get_or_insert(reason);
        }
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn publish(&self, v: Value) {
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        {
            let mut inner = self.lock();
            match kind {
                "progress" => {
                    let c = v.pointer("/progress/current").and_then(|x| x.as_u64());
                    let t = v.pointer("/progress/total").and_then(|x| x.as_u64());
                    if let (Some(c), Some(t)) = (c, t) {
                        inner.progress = Some((c as u32, t as u32));
                    }
                }
                "log" => {
                    if let Some(line) = v.get("line").and_then(|l| l.as_str()) {
                        inner.log_tail.push_back(line.to_string());
                        while inner.log_tail.len() > LOG_TAIL_LINES {
                            inner.log_tail.pop_front();
                        }
                    }
                }
                "item" => {
                    if let Some(item) = v.get("item") {
                        let key = item_key(item);
                        if let Some(slot) = inner.items.iter_mut().find(|x| item_key(x) == key) {
                            *slot = item.clone();
                        } else {
                            inner.items.push(item.clone());
                        }
                    }
                }
                _ => {}
            }
        }
        let event = Arc::new(Event {
            done: kind == "done",
            line: v.to_string(),
        });
        let _ = self.events.send(event);
    }

    /// Status for `GET /download/active`.
    pub fn status_json(&self) -> Value {
        let inner = self.lock();
        let count = |s: &str| {
            inner
                .items
                .iter()
                .filter(|i| i.get("status").and_then(|x| x.as_str()) == Some(s))
                .count()
        };
        json!({
            "downloadId": self.id,
            "kind": self.kind,
            "outputDir": self.output_dir,
            "accountId": self.account_id,
            "background": self.background,
            "status": inner.status.as_str(),
            "startedAt": self.started_at,
            "finishedAt": inner.finished_at_rfc,
            "progress": inner.progress.map(|(c, t)| json!({ "current": c, "total": t })),
            "counts": {
                "downloaded": count("downloaded"),
                "skipped": count("skipped"),
                "failed": count("failed"),
            },
            "items": inner.items,
            "logTail": inner.log_tail,
            "canCancel": inner.status == JobStatus::Running,
            "attachedStreams": self.subscribers.load(Ordering::SeqCst),
            "cancelReason": inner.cancel_reason,
            "done": inner.done,
        })
    }
}

fn item_key(item: &Value) -> String {
    item.get("id")
        .and_then(|v| v.as_str())
        .map(|s| format!("id:{s}"))
        .or_else(|| {
            item.get("index")
                .and_then(|v| v.as_u64())
                .map(|i| format!("ix:{i}"))
        })
        .unwrap_or_else(|| {
            item.get("files")
                .map(|f| format!("f:{f}"))
                .unwrap_or_default()
        })
}

fn registry() -> &'static Mutex<HashMap<String, Arc<DownloadJob>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<DownloadJob>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune(map: &mut HashMap<String, Arc<DownloadJob>>) {
    map.retain(|_, job| {
        job.lock()
            .finished_at
            .map(|t| t.elapsed() < FINISHED_RETENTION)
            .unwrap_or(true)
    });
}

fn hub_id(state: &AppState) -> PathBuf {
    state.config.lock_or_recover().data_dir.clone()
}

/// Jobs of this hub, newest first.
pub fn list(state: &AppState) -> Vec<Arc<DownloadJob>> {
    let hub = hub_id(state);
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    prune(&mut map);
    let mut jobs: Vec<_> = map.values().filter(|j| j.hub == hub).cloned().collect();
    jobs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    jobs
}

pub fn find(state: &AppState, id: &str) -> Option<Arc<DownloadJob>> {
    let hub = hub_id(state);
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.get(id.trim()).filter(|j| j.hub == hub).cloned()
}

/// NDJSON body stream.
pub type NdjsonStream = futures::stream::BoxStream<'static, Result<Bytes, Infallible>>;

fn to_body_stream(rx: mpsc::Receiver<String>) -> NdjsonStream {
    Box::pin(ReceiverStream::new(rx).map(|line| {
        let payload = if line.ends_with('\n') {
            line
        } else {
            format!("{line}\n")
        };
        Ok::<_, Infallible>(Bytes::from(payload))
    }))
}

/// Attach an NDJSON stream to `job`. With `snapshot`, the stream starts with
/// the job status (and `done` when it already finished).
pub fn attach(job: Arc<DownloadJob>, snapshot: bool) -> NdjsonStream {
    let mut rx = job.events.subscribe();
    let (tx, out) = mpsc::channel::<String>(256);
    job.subscribers.fetch_add(1, Ordering::SeqCst);
    let mut initial = Vec::new();
    let mut already_done = false;
    if snapshot {
        let status = job.status_json();
        let done = status.get("done").cloned().filter(|d| !d.is_null());
        initial.push(json!({ "type": "snapshot", "download": status }).to_string());
        if let Some(d) = done {
            initial.push(d.to_string());
            already_done = true;
        }
    }
    tokio::spawn(async move {
        let mut finished = already_done;
        let mut gone = false;
        for line in initial {
            if tx.send(line).await.is_err() {
                gone = true;
                break;
            }
        }
        while !finished && !gone {
            tokio::select! {
                _ = tx.closed() => gone = true,
                ev = rx.recv() => match ev {
                    Ok(ev) => {
                        if tx.send(ev.line.clone()).await.is_err() {
                            gone = true;
                        } else if ev.done {
                            finished = true;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => finished = true,
                },
            }
        }
        let left = job
            .subscribers
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        if gone && left == 0 && !job.background && job.status() == JobStatus::Running {
            tracing::info!(download = %job.id, "download client disconnected: stopping yt-dlp");
            job.request_cancel("client_disconnected");
        }
    });
    to_body_stream(out)
}

/// Validated download request.
pub struct StartRequest {
    pub download_id: String,
    pub url: String,
    pub kind: String,
    pub output_dir: String,
    pub account_id: String,
    pub background: bool,
    pub music_root: PathBuf,
}

/// Register and start a job; the returned stream is attached to it.
pub fn start(state: &AppState, req: StartRequest) -> Result<NdjsonStream, &'static str> {
    let hub = hub_id(state);
    let cancel = Arc::new(AtomicBool::new(false));
    let (events, _) = broadcast::channel(EVENT_BUFFER);
    let job = Arc::new(DownloadJob {
        id: req.download_id.clone(),
        hub,
        kind: req.kind.clone(),
        output_dir: req.output_dir.clone(),
        account_id: req.account_id.clone(),
        background: req.background,
        started_at: chrono::Utc::now().to_rfc3339(),
        cancel: cancel.clone(),
        events,
        subscribers: AtomicUsize::new(0),
        inner: Mutex::new(JobInner {
            status: JobStatus::Running,
            progress: None,
            log_tail: VecDeque::new(),
            items: Vec::new(),
            cancel_reason: None,
            done: None,
            finished_at: None,
            finished_at_rfc: None,
        }),
    });
    {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut map);
        if map.contains_key(&req.download_id) {
            return Err("download_id_active");
        }
        let mut active = state.active_downloads.lock_or_recover();
        if active.contains_key(&req.download_id) {
            return Err("download_id_active");
        }
        active.insert(req.download_id.clone(), cancel);
        map.insert(req.download_id.clone(), job.clone());
    }
    // Subscribe before the runner can emit anything.
    let stream = attach(job.clone(), false);
    let state = state.clone();
    tokio::spawn(run_job(state, job, req));
    Ok(stream)
}

async fn run_job(state: AppState, job: Arc<DownloadJob>, req: StartRequest) {
    // A download keeps the computer awake until it ends (`whenActive`).
    let _activity = state.power.begin(crate::power::ActivityKind::Job);
    let cfg = state.config.lock_or_recover().clone();
    let toolchain = Toolchain::resolve(&cfg).await;
    let ytdlp_info = crate::tools::peek(
        crate::tools::Tool::Ytdlp,
        &crate::tools::ToolContext::from_config(&cfg),
    );
    job.publish(json!({
        "type": "started",
        "downloadId": job.id,
        "background": job.background,
        "ytdlp": {
            "version": ytdlp_info.as_ref().and_then(|t| t.version.clone()),
            "source": ytdlp_info.as_ref().and_then(|t| t.source),
        },
        "ffmpeg": toolchain.ffmpeg.is_some(),
        "jsRuntime": toolchain
            .js_runtime
            .as_deref()
            .and_then(|r| r.split(':').next()),
    }));

    // Tags and cover (5.2), written by the hub after the run.
    let tags_on = cfg.embedded.embed_downloads;
    // A single goes after the folder's last track, not always to `01 - …`.
    let single_slot = if req.kind == "download_single"
        && crate::path_util::rel_path_looks_like_album_folder(&req.output_dir)
    {
        let dir = req.music_root.join(&req.output_dir);
        tokio::task::spawn_blocking(move || download_tags::next_track_slot(&dir))
            .await
            .ok()
    } else {
        None
    };
    let extras = DownloadExtras {
        single_slot,
        tags: tags_on,
    };

    let (ev_tx, mut ev_rx) = mpsc::channel::<Value>(256);
    let pump_job = job.clone();
    let pump = tokio::spawn(async move {
        while let Some(v) = ev_rx.recv().await {
            pump_job.publish(v);
        }
    });
    let outcome = ytdlp::run_download(
        &cfg,
        &toolchain,
        &req.music_root,
        &req.url,
        &req.kind,
        &req.output_dir,
        &extras,
        job.cancel.clone(),
        ev_tx,
    )
    .await;
    let _ = pump.await;
    state.active_downloads.lock_or_recover().remove(&job.id);

    let mut outcome = match outcome {
        Ok(o) => o,
        Err(e) => DownloadOutcome {
            exit_code: -1,
            cancelled: job.cancel.load(Ordering::SeqCst),
            spawn_error: Some("download_failed"),
            summary: Default::default(),
            progress: None,
            stdout: String::new(),
            stderr: e.to_string(),
            log_truncated: false,
            stdout_total: 0,
            stderr_total: 0,
            command: String::new(),
        },
    };

    let tags = if tags_on && outcome.summary.downloaded > 0 {
        Some(tag_downloads(&state, &job, &req, &toolchain, &mut outcome).await)
    } else {
        None
    };

    let succeeded = outcome.succeeded();
    let mut rescanned = false;
    let mut index_epoch: Option<u64> = None;
    let mut rescan_error: Option<String> = None;
    if succeeded {
        job.lock().status = JobStatus::Indexing;
        job.publish(json!({ "type": "indexing", "outputDir": job.output_dir }));
        let refresh = refresh_output_folder(&state, &job.output_dir);
        tokio::pin!(refresh);
        let mut keepalive = tokio::time::interval(Duration::from_secs(5));
        keepalive.tick().await;
        let res = loop {
            tokio::select! {
                r = &mut refresh => break r,
                _ = keepalive.tick() => job.publish(json!({ "type": "keepalive" })),
            }
        };
        match res {
            Ok(epoch) => {
                rescanned = true;
                index_epoch = Some(epoch);
                if !job.output_dir.is_empty() {
                    crate::studio::attach_download_to_selection(
                        &state,
                        &job.account_id,
                        &job.output_dir,
                    );
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "post-download library refresh failed");
                rescan_error = Some(e.to_string());
            }
        }
    }
    // Same counter as `/library/stats` → `index_epoch`; unchanged when
    // nothing was re-indexed (failure / cancel).
    let index_epoch = index_epoch.unwrap_or_else(|| {
        state
            .db
            .get_meta("index_epoch")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    });

    let cancel_reason = job.lock().cancel_reason;
    let error = outcome.error_code().map(|c| match (c, cancel_reason) {
        ("cancelled", Some(reason)) => reason,
        (c, _) => c,
    });
    let s = &outcome.summary;
    job.publish(json!({
        "type": "items",
        "downloadedItems": s.downloaded_items,
        "skippedItems": s.skipped_items,
        "failedItems": s.failed_items,
    }));
    let done = json!({
        "type": "done",
        "downloadId": job.id,
        "ok": succeeded,
        "partial": succeeded && s.failed > 0,
        "cancelled": outcome.cancelled,
        "cancelReason": if outcome.cancelled { cancel_reason.or(Some("user")) } else { None },
        "error": error,
        "code": outcome.exit_code,
        "summary": {
            "downloaded": s.downloaded,
            "skipped": s.skipped,
            "failed": s.failed,
            "total": s.total,
        },
        "downloadedItems": s.downloaded_items,
        "skippedItems": s.skipped_items,
        "failedItems": s.failed_items,
        "items": s.items,
        "formats": s.formats,
        "progress": outcome.progress.map(|(c, t)| json!({ "current": c, "total": t })),
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "logTruncated": outcome.log_truncated,
        "stdoutTotalChars": outcome.stdout_total,
        "stderrTotalChars": outcome.stderr_total,
        "command": outcome.command,
        "outputDir": job.output_dir,
        "rescanned": rescanned,
        "rescanError": rescan_error,
        "indexEpoch": index_epoch,
        "tags": tags,
    });

    let data_dir = cfg.data_dir.clone();
    let folder = if job.output_dir.is_empty() {
        "."
    } else {
        job.output_dir.as_str()
    };
    let verdict = if succeeded {
        "finished"
    } else if outcome.cancelled {
        "cancelled"
    } else {
        "failed"
    };
    crate::diagnostics::log_activity(
        &data_dir,
        crate::diagnostics::ActivityEvent::new(
            "download",
            verdict,
            format!(
                "download {verdict} ({}): {folder} — {} ok, {} skipped, {} failed",
                job.kind, s.downloaded, s.skipped, s.failed
            ),
        )
        .params(json!({
            "kind": job.kind,
            "folder": folder,
            "ok": s.downloaded,
            "skipped": s.skipped,
            "failed": s.failed,
        }))
        .account(Some(&job.account_id)),
    );

    {
        let mut inner = job.lock();
        inner.status = if succeeded {
            JobStatus::Done
        } else if outcome.cancelled {
            JobStatus::Cancelled
        } else {
            JobStatus::Failed
        };
        inner.done = Some(done.clone());
        inner.finished_at = Some(Instant::now());
        inner.finished_at_rfc = Some(chrono::Utc::now().to_rfc3339());
        debug_assert!(inner.status.finished());
    }
    job.publish(done);
}

/// Write tags and covers into the files this run downloaded (off the async
/// workers), publish a `tagged` event and point the summary at renamed
/// files (WebM copied into Opus).
async fn tag_downloads(
    state: &AppState,
    job: &DownloadJob,
    req: &StartRequest,
    toolchain: &Toolchain,
    outcome: &mut DownloadOutcome,
) -> download_tags::TagReport {
    let items = outcome.summary.items.clone();
    let root = req.music_root.clone();
    let kind = req.kind.clone();
    let ffmpeg = toolchain.ffmpeg.clone();
    let db = state.db.clone();
    // Redirects stay on the thumbnail hosts (see `download_tags`).
    let client = download_tags::thumbnail_client();
    let rt = tokio::runtime::Handle::current();
    let report = tokio::task::spawn_blocking(move || {
        let has_cover = |folder: &str| db.album_has_cover_by_folder(folder).unwrap_or(false);
        let fetch = |url: &str| -> Option<Vec<u8>> {
            let client = client.as_ref()?;
            rt.block_on(download_tags::fetch_thumbnail(client, url))
        };
        download_tags::finish_downloads(
            &download_tags::FinishJob {
                music_root: &root,
                kind: &kind,
                fetch: &fetch,
                ffmpeg: ffmpeg.as_deref(),
                has_cover: &has_cover,
            },
            &items,
        )
    })
    .await
    .unwrap_or_default();
    for (old, new) in &report.renamed {
        let rename = |list: &mut Vec<String>| {
            for f in list.iter_mut().filter(|f| f.replace('\\', "/") == *old) {
                *f = new.clone();
            }
        };
        rename(&mut outcome.summary.downloaded_items);
        for item in &mut outcome.summary.items {
            rename(&mut item.files);
        }
    }
    for f in &report.failed {
        tracing::warn!(file = %f.file, reason = %f.reason, "download tags not written");
    }
    let mut event = serde_json::to_value(&report).unwrap_or_else(|_| json!({}));
    event["type"] = json!("tagged");
    job.publish(event);
    report
}

/// Re-index only the folder a download wrote to; returns the new index
/// epoch. A download into the library root (folders named by yt-dlp) needs
/// the incremental full scan instead.
async fn refresh_output_folder(state: &AppState, rel_dir: &str) -> anyhow::Result<u64> {
    if !rel_dir.trim().trim_matches('/').is_empty() {
        return state.rescan_path(rel_dir).await;
    }
    state.rescan_after_change().await?;
    Ok(state
        .db
        .get_meta("index_epoch")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0))
}
