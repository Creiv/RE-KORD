//! Background job registry (parity `server/jobs/queue.mjs` + `/api/jobs`).
//!
//! Long operations (scan, thumbnail backfill, restore, legacy sync, downloads)
//! register here so the admin panel can show progress and cancel them.

use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
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
}

pub struct JobRegistry {
    jobs: Mutex<Vec<Job>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
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
        }
    }

    pub fn start(self: &Arc<Self>, kind: &str, label: &str, cancelable: bool) -> JobHandle {
        let id = Uuid::new_v4().to_string();
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
        };
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.push(job);
            prune(&mut jobs);
        }
        if cancelable {
            self.cancels
                .lock()
                .unwrap()
                .insert(id.clone(), cancel.clone());
        }
        JobHandle {
            registry: self.clone(),
            id,
            cancel,
            settled: AtomicBool::new(false),
        }
    }

    /// Jobs newest-first, running ones on top.
    pub fn list(&self) -> Vec<Job> {
        let jobs = self.jobs.lock().unwrap();
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
            .lock()
            .unwrap()
            .iter()
            .filter(|j| j.status == JobStatus::Running)
            .count()
    }

    /// Returns false when the job is unknown or not cancelable.
    pub fn cancel(&self, id: &str) -> bool {
        let flag = self.cancels.lock().unwrap().get(id).cloned();
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                if let Ok(mut jobs) = self.jobs.lock() {
                    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                        job.message = Some("annullamento richiesto".into());
                    }
                }
                true
            }
            None => false,
        }
    }

    pub fn clear_finished(&self) -> usize {
        let mut jobs = self.jobs.lock().unwrap();
        let before = jobs.len();
        jobs.retain(|j| j.status == JobStatus::Running);
        before - jobs.len()
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                f(job);
            }
        }
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
}

impl JobHandle {
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
        let msg = message.into();
        self.registry.update(&self.id, |job| {
            job.progress = Some(value.clamp(0.0, 1.0));
            job.message = Some(msg);
        });
    }

    pub fn message(&self, message: impl Into<String>) {
        let msg = message.into();
        self.registry
            .update(&self.id, |job| job.message = Some(msg));
    }

    pub fn finish(&self, message: impl Into<String>) {
        if self.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        let msg = message.into();
        let canceled = self.is_canceled();
        self.registry.update(&self.id, |job| {
            job.status = if canceled {
                JobStatus::Canceled
            } else {
                JobStatus::Done
            };
            job.progress = Some(1.0);
            job.message = Some(msg);
            job.finished_at = Some(chrono::Utc::now().to_rfc3339());
        });
        self.registry.cancels.lock().unwrap().remove(&self.id);
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
        self.registry.cancels.lock().unwrap().remove(&self.id);
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
                job.finished_at = Some(chrono::Utc::now().to_rfc3339());
            }
        });
        self.registry.cancels.lock().unwrap().remove(&self.id);
    }
}

pub type SharedJobs = Arc<JobRegistry>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs", get(list_jobs).delete(clear_jobs))
        .route("/api/jobs", get(list_jobs).delete(clear_jobs))
        .route("/api/v1/jobs/{id}/cancel", post(cancel_job))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
}

async fn list_jobs(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "ok": true, "data": state.jobs.list() }))
}

async fn cancel_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
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

async fn clear_jobs(State(state): State<AppState>) -> impl IntoResponse {
    let removed = state.jobs.clear_finished();
    Json(json!({ "ok": true, "data": { "removed": removed } }))
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
        assert!(!jobs.iter().any(|j| j.id == ids[0]), "oldest one goes first");
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
