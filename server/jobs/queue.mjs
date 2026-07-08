/**
 * Coda job in-process per operazioni pesanti (scan, enrichment, thumbnail).
 */
import { getLogger } from "../logger.mjs";

/** @typedef {'pending'|'running'|'completed'|'failed'|'cancelled'} JobStatus */
/** @typedef {'library_scan'|'thumb_backfill'|'enrichment'} JobType */

/** @type {Map<string, { id: string, type: JobType, status: JobStatus, progress: number, message: string, error: string | null, createdAt: number, updatedAt: number, cancel?: () => void }>} */
const jobs = new Map();
let jobCounter = 0;
let runningCount = 0;
const MAX_CONCURRENT = 2;

/** @type {Array<{ id: string, type: JobType, run: (ctx: { signal: AbortSignal, setProgress: (n: number, msg?: string) => void }) => Promise<void> }>} */
const queue = [];

/**
 * @param {JobType} type
 * @param {(ctx: { signal: AbortSignal, setProgress: (n: number, msg?: string) => void }) => Promise<void>} run
 * @returns {string}
 */
export function enqueueJob(type, run) {
  const id = `job-${++jobCounter}-${Date.now()}`;
  const job = {
    id,
    type,
    status: /** @type {JobStatus} */ ("pending"),
    progress: 0,
    message: "Queued",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    run,
  };
  jobs.set(id, job);
  queue.push(job);
  void pumpQueue();
  return id;
}

async function pumpQueue() {
  while (runningCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.status === "cancelled") continue;
    runningCount += 1;
    job.status = "running";
    job.updatedAt = Date.now();
    const controller = new AbortController();
    job.cancel = () => controller.abort();
    const setProgress = (n, msg) => {
      job.progress = Math.max(0, Math.min(100, Number(n) || 0));
      if (msg) job.message = String(msg);
      job.updatedAt = Date.now();
    };
    try {
      await job.run({ signal: controller.signal, setProgress });
      if (job.status !== "cancelled") {
        job.status = "completed";
        job.progress = 100;
        job.message = "Completed";
      }
    } catch (err) {
      if (controller.signal.aborted || job.status === "cancelled") {
        job.status = "cancelled";
        job.message = "Cancelled";
      } else {
        job.status = "failed";
        job.error = String(err?.message || err);
        job.message = "Failed";
        getLogger().warn({ err, jobId: job.id, type: job.type }, "Job failed");
      }
    } finally {
      job.updatedAt = Date.now();
      runningCount -= 1;
      delete job.run;
      delete job.cancel;
    }
  }
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ run: _run, cancel: _cancel, ...rest }) => rest);
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { run: _run, cancel: _cancel, ...rest } = job;
  return rest;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "pending") {
    job.status = "cancelled";
    job.message = "Cancelled";
    job.updatedAt = Date.now();
    const idx = queue.findIndex((item) => item.id === id);
    if (idx >= 0) queue.splice(idx, 1);
    return true;
  }
  if (job.status === "running" && job.cancel) {
    job.status = "cancelled";
    job.cancel();
    return true;
  }
  return false;
}

export function cancelAllJobs() {
  for (const job of jobs.values()) {
    if (job.status === "pending" || job.status === "running") {
      cancelJob(job.id);
    }
  }
}
