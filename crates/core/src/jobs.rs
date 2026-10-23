//! Background job registry (parity `server/jobs/queue.mjs` + `/api/jobs`).
//!
//! Long operations (scan, thumbnail backfill, restore, legacy sync, downloads)
//! register here so the admin panel can show progress and cancel them.

use crate::perm::PeerAddr;
use crate::state::AppState;
use crate::sync::LockRecover;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Finished jobs kept for the panel history.
const MAX_HISTORY: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Failed,
    Canceled,
}

impl JobStatus {
    fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: JobStatus,
    /// 0.0..=1.0 when known.
    pub progress: Option<f32>,
    pub message: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub cancelable: bool,
    /// Stable code for `label` (`scan.title`, …) the panels translate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_code: Option<String>,
    /// Stable code for `message` (`scan.done`, `cancelRequested`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_code: Option<String>,
    /// Stable code for `error` when the hub wrote it (`interrupted`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// Placeholders for the coded texts (`{ "mode": "full", "indexed": 533 }`).
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

/// Merge an object of params into the job's (other values are ignored).
fn merge_params(into: &mut Map<String, Value>, params: Value) {
    if let Value::Object(map) = params {
        into.extend(map);
    }
}

pub struct JobRegistry {
    jobs: Mutex<Vec<Job>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Running jobs keep the computer awake (sleep prevention, `whenActive`).
    power: Option<crate::power::PowerManager>,
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            cancels: Mutex::new(HashMap::new()),
            power: None,
        }
    }

    /// A registry whose running jobs count as hub activity.
    pub fn with_power(power: crate::power::PowerManager) -> Self {
        Self {
            power: Some(power),
            ..Self::new()
        }
    }

    pub fn start(self: &Arc<Self>, kind: &str, label: &str, cancelable: bool) -> JobHandle {
        self.start_job(kind, label, None, Value::Null, cancelable)
    }

    /// Like [`start`](Self::start), with a translatable title code and params.
    pub fn start_coded(
        self: &Arc<Self>,
        kind: &str,
        label: &str,
        title_code: &str,
        params: Value,
        cancelable: bool,
    ) -> JobHandle {
        self.start_job(kind, label, Some(title_code), params, cancelable)
    }

    fn start_job(
        self: &Arc<Self>,
        kind: &str,
        label: &str,
        title_code: Option<&str>,
        params: Value,
        cancelable: bool,
    ) -> JobHandle {
        let id = Uuid::new_v4().to_string();
        let mut job_params = Map::new();
        merge_params(&mut job_params, params);
        let job = Job {
            id: id.clone(),
            kind: kind.to_string(),
            label: label.to_string(),
            status: JobStatus::Running,
            progress: None,
            message: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
            error: None,
            cancelable,
            title_code: title_code.map(str::to_string),
            detail_code: None,
            error_code: None,
            params: job_params,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock_or_recover();
            jobs.push(job);
            crate::events::publish("jobs", serde_json::json!({ "id": id, "started": true }));
            prune(&mut jobs);
        }
        if cancelable {
            self.cancels
                .lock_or_recover()
                .insert(id.clone(), cancel.clone());
        }
        JobHandle {
            registry: self.clone(),
            id,
            cancel,
            settled: AtomicBool::new(false),
            activity: Mutex::new(
                self.power
                    .as_ref()
                    .map(|p| p.begin(crate::power::ActivityKind::Job)),
            ),
        }
    }

    /// Jobs newest-first, running ones on top.
    pub fn list(&self) -> Vec<Job> {
        let jobs = self.jobs.lock_or_recover();
        let mut out = jobs.clone();
        out.sort_by(|a, b| {
            let a_run = a.status == JobStatus::Running;
            let b_run = b.status == JobStatus::Running;
            b_run.cmp(&a_run).then(b.created_at.cmp(&a.created_at))
        });
        out
    }

    pub fn active_count(&self) -> usize {
        self.jobs
            .lock_or_recover()
            .iter()
            .filter(|j| j.status == JobStatus::Running)
            .count()
    }

    /// Returns false when the job is unknown or not cancelable.
    pub fn cancel(&self, id: &str) -> bool {
        let flag = self.cancels.lock_or_recover().get(id).cloned();
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                if let Ok(mut jobs) = self.jobs.lock() {
                    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                        job.message = Some("annullamento richiesto".into());
                        job.detail_code = Some("cancelRequested".into());
                    }
                }
                true
            }
            None => false,
        }
    }

    /// One job by id (running or in history).
    pub fn get(&self, id: &str) -> Option<Job> {
        self.jobs
            .lock_or_recover()
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }

    /// Flag every cancelable running job (hub shutdown).
    pub fn cancel_all(&self) -> usize {
        let ids: Vec<String> = self.cancels.lock_or_recover().keys().cloned().collect();
        ids.iter().filter(|id| self.cancel(id)).count()
    }

    pub fn clear_finished(&self) -> usize {
        let removed = {
            let mut jobs = self.jobs.lock_or_recover();
            let before = jobs.len();
            jobs.retain(|j| j.status == JobStatus::Running);
            before - jobs.len()
        };
        if removed > 0 {
            crate::events::publish("jobs", serde_json::json!({ "cleared": removed }));
        }
        removed
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                f(job);
            }
        }
        crate::events::publish("jobs", serde_json::json!({ "id": id }));
    }
}

fn prune(jobs: &mut Vec<Job>) {
    let finished: Vec<usize> = jobs
        .iter()
        .enumerate()
        .filter(|(_, j)| j.status.is_terminal())
        .map(|(i, _)| i)
        .collect();
    if finished.len() <= MAX_HISTORY {
        return;
    }
    let drop_count = finished.len() - MAX_HISTORY;
    let mut dropped = 0usize;
    jobs.retain(|j| {
        if dropped < drop_count && j.status.is_terminal() {
            dropped += 1;
            return false;
        }
        true
    });
}

/// Handle held by the worker; marks the job failed if dropped without finishing.
pub struct JobHandle {
    registry: Arc<JobRegistry>,
    id: String,
    cancel: Arc<AtomicBool>,
    settled: AtomicBool,
    /// Held until the job settles.
    activity: Mutex<Option<crate::power::ActivityGuard>>,
}

impl JobHandle {
    fn end_activity(&self) {
        drop(
            self.activity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(),
        );
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn progress(&self, value: f32, message: impl Into<String>) {
        self.set_progress(value, None, Value::Null, message.into());
    }

    /// Progress with a translatable detail code; `message` is the plain text.
    pub fn progress_coded(
        &self,
        value: f32,
        code: &str,
        params: Value,
        message: impl Into<String>,
    ) {
        self.set_progress(value, Some(code), params, message.into());
    }

    fn set_progress(&self, value: f32, code: Option<&str>, params: Value, msg: String) {
        self.registry.update(&self.id, |job| {
            job.progress = Some(value.clamp(0.0, 1.0));
            job.message = Some(msg);
            job.detail_code = code.map(str::to_string);
            merge_params(&mut job.params, params);
        });
    }

    pub fn message(&self, message: impl Into<String>) {
        self.set_message(None, Value::Null, message.into());
    }

    /// Detail line with a translatable code; `message` is the plain text.
    pub fn message_coded(&self, code: &str, params: Value, message: impl Into<String>) {
        self.set_message(Some(code), params, message.into());
    }

    fn set_message(&self, code: Option<&str>, params: Value, msg: String) {
        self.registry.update(&self.id, |job| {
            job.message = Some(msg);
            job.detail_code = code.map(str::to_string);
            merge_params(&mut job.params, params);
        });
    }

    pub fn finish(&self, message: impl Into<String>) {
        self.settle_done(None, Value::Null, message.into());
    }

    /// Finish with a translatable detail code; `message` is the plain text.
    pub fn finish_coded(&self, code: &str, params: Value, message: impl Into<String>) {
        self.settle_done(Some(code), params, message.into());
    }

    fn settle_done(&self, code: Option<&str>, params: Value, msg: String) {
        if self.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        let canceled = self.is_canceled();
        self.registry.update(&self.id, |job| {
            job.status = if canceled {
                JobStatus::Canceled
            } else {
                JobStatus::Done
            };
            job.progress = Some(1.0);
            job.message = Some(msg);
            job.detail_code = code.map(str::to_string);
            merge_params(&mut job.params, params);
            job.finished_at = Some(chrono::Utc::now().to_rfc3339());
        });
        self.registry.cancels.lock_or_recover().remove(&self.id);
        self.end_activity();
    }

    pub fn fail(&self, error: impl Into<String>) {
        if self.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        let err = error.into();
        self.registry.update(&self.id, |job| {
            job.status = JobStatus::Failed;
            job.error = Some(err);
            job.finished_at = Some(chrono::Utc::now().to_rfc3339());
        });
        self.registry.cancels.lock_or_recover().remove(&self.id);
        self.end_activity();
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        // Reached only when the worker panicked or returned early.
        self.registry.update(&self.id, |job| {
            if job.status == JobStatus::Running {
                job.status = JobStatus::Failed;
                job.error = Some("interrotto".into());
                job.error_code = Some("interrupted".into());
                job.finished_at = Some(chrono::Utc::now().to_rfc3339());
            }
        });
        self.registry.cancels.lock_or_recover().remove(&self.id);
        self.end_activity();
    }
}

pub type SharedJobs = Arc<JobRegistry>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs", get(list_jobs).delete(clear_jobs))
        .route("/api/jobs", get(list_jobs).delete(clear_jobs))
        .route("/api/v1/jobs/{id}", get(get_job))
        .route("/api/jobs/{id}", get(get_job))
        .route("/api/v1/jobs/{id}/cancel", post(cancel_job))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
}

#[derive(Debug, Deserialize, Default)]
struct AccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn list_jobs(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "ok": true, "data": state.jobs.list() }))
}

async fn get_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.jobs.get(&id) {
        Some(job) => Json(json!({ "ok": true, "data": job })).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "job non trovato" })),
        )
            .into_response(),
    }
}

/// Cancelling / clearing jobs acts on host-wide work: machine operation
/// (legacy `ADMIN_MUTATION_PATHS` `/api/jobs/:id/cancel`).
async fn cancel_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = crate::perm::require_machine_op(&state, &headers, q.account_id.as_deref(), peer)
    {
        return r;
    }
    if state.jobs.cancel(&id) {
        Json(json!({ "ok": true, "data": { "id": id } })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "job non annullabile o inesistente" })),
        )
            .into_response()
    }
}

async fn clear_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Query(q): Query<AccountQuery>,
) -> Response {
    if let Err(r) = crate::perm::require_machine_op(&state, &headers, q.account_id.as_deref(), peer)
    {
        return r;
    }
    let removed = state.jobs.clear_finished();
    Json(json!({ "ok": true, "data": { "removed": removed } })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_jobs_report_done_and_leave_history() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("scan", "Scan libreria", true);
        assert_eq!(reg.active_count(), 1);
        handle.progress(0.5, "meta");
        handle.finish("ok");
        assert_eq!(reg.active_count(), 0);
        let jobs = reg.list();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, JobStatus::Done);
        assert_eq!(jobs[0].progress, Some(1.0));
    }

    #[test]
    fn coded_jobs_carry_codes_and_params_next_to_the_text() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start_coded(
            "scan",
            "Scan libreria (full)",
            "scan.title",
            json!({ "mode": "full" }),
            true,
        );
        handle.progress_coded(0.8, "scan.metadata", Value::Null, "metadati");
        assert_eq!(reg.list()[0].detail_code.as_deref(), Some("scan.metadata"));
        handle.finish_coded(
            "scan.done",
            json!({ "indexed": 533, "removed": 0 }),
            "533 tracce indicizzate, 0 rimosse",
        );
        let job = serde_json::to_value(&reg.list()[0]).unwrap();
        assert_eq!(job["label"], "Scan libreria (full)");
        assert_eq!(job["titleCode"], "scan.title");
        assert_eq!(job["detailCode"], "scan.done");
        assert_eq!(job["message"], "533 tracce indicizzate, 0 rimosse");
        assert_eq!(
            job["params"],
            json!({ "mode": "full", "indexed": 533, "removed": 0 })
        );
        assert!(job.get("errorCode").is_none());
    }

    #[test]
    fn cancel_flags_the_running_job() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("thumbs", "Miniature", true);
        assert!(reg.cancel(handle.id()));
        assert!(handle.is_canceled());
        handle.finish("stop");
        assert_eq!(reg.list()[0].status, JobStatus::Canceled);
    }

    #[test]
    fn non_cancelable_jobs_reject_cancel() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("restore", "Restore", false);
        assert!(!reg.cancel(handle.id()));
        handle.finish("ok");
    }

    #[test]
    fn clear_finished_keeps_running_jobs() {
        let reg = Arc::new(JobRegistry::new());
        let running = reg.start("scan", "Scan", true);
        let done = reg.start("scan", "Scan 2", true);
        done.finish("ok");
        assert_eq!(reg.clear_finished(), 1);
        assert_eq!(reg.list().len(), 1);
        running.finish("ok");
    }

    #[test]
    fn a_failed_job_keeps_the_reason() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("download", "Download", true);
        handle.fail("yt-dlp non risponde");
        let job = &reg.list()[0];
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("yt-dlp non risponde"));
        assert!(job.finished_at.is_some());
    }

    #[test]
    fn the_first_verdict_is_the_one_that_counts() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("scan", "Scan", true);
        handle.fail("disco pieno");
        // A worker reporting success after a failure does not rewrite history.
        handle.finish("ok");
        let job = &reg.list()[0];
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("disco pieno"));
    }

    #[test]
    fn a_worker_that_disappears_leaves_the_job_interrupted() {
        let reg = Arc::new(JobRegistry::new());
        {
            // Handle dropped without finish/fail: the worker panicked or returned early.
            let _handle = reg.start("thumbs", "Miniature", true);
            assert_eq!(reg.active_count(), 1);
        }
        let job = &reg.list()[0];
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("interrotto"));
        assert_eq!(reg.active_count(), 0);
    }

    #[test]
    fn progress_never_leaves_zero_to_one() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("scan", "Scan", true);
        handle.progress(5.0, "oltre");
        assert_eq!(reg.list()[0].progress, Some(1.0));
        handle.progress(-2.0, "sotto");
        assert_eq!(reg.list()[0].progress, Some(0.0));
        handle.finish("ok");
    }

    #[test]
    fn a_job_already_finished_cannot_be_canceled() {
        let reg = Arc::new(JobRegistry::new());
        let handle = reg.start("scan", "Scan", true);
        handle.finish("ok");
        assert!(!reg.cancel(handle.id()));
        assert!(!reg.cancel("un-id-che-non-esiste"));
        assert_eq!(reg.list()[0].status, JobStatus::Done);
    }

    #[test]
    fn running_jobs_stay_on_top_then_newest_first() {
        let reg = Arc::new(JobRegistry::new());
        let first = reg.start("scan", "Vecchio", true);
        first.finish("ok");
        let second = reg.start("scan", "Recente", true);
        second.finish("ok");
        let running = reg.start("scan", "In corso", true);

        let jobs = reg.list();
        assert_eq!(jobs[0].label, "In corso");
        assert_eq!(jobs[1].label, "Recente");
        assert_eq!(jobs[2].label, "Vecchio");
        running.finish("ok");
    }

    #[test]
    fn history_stops_at_sixty_and_the_oldest_goes_first() {
        let reg = Arc::new(JobRegistry::new());
        let mut ids = Vec::new();
        for i in 0..MAX_HISTORY + 5 {
            let handle = reg.start("scan", &format!("Scan {i}"), false);
            ids.push(handle.id().to_string());
            handle.finish("ok");
        }
        // Pruning happens when the next job starts.
        let running = reg.start("scan", "In corso", false);

        let jobs = reg.list();
        let finished = jobs.iter().filter(|j| j.status.is_terminal()).count();
        assert_eq!(finished, MAX_HISTORY);
        assert!(jobs.iter().any(|j| j.label == "In corso"));
        assert!(
            !jobs.iter().any(|j| j.id == ids[0]),
            "oldest one goes first"
        );
        assert!(jobs.iter().any(|j| j.id == *ids.last().unwrap()));
        running.finish("ok");
    }

    #[test]
    fn a_full_history_never_hides_a_running_job() {
        let reg = Arc::new(JobRegistry::new());
        let running = reg.start("scan", "Scan libreria", true);
        for i in 0..MAX_HISTORY + 10 {
            reg.start("thumbs", &format!("Miniature {i}"), false)
                .finish("ok");
        }
        let jobs = reg.list();
        assert_eq!(reg.active_count(), 1);
        assert_eq!(jobs[0].id, running.id());
        running.finish("ok");
    }
}
