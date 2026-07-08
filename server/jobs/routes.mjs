import { sendError, sendOk } from "../httpUtils.mjs";
import { cancelJob, getJob, listJobs } from "./queue.mjs";

export function registerJobRoutes(app) {
  app.get("/api/jobs", (_req, res) => {
    return sendOk(res, { jobs: listJobs() });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = getJob(String(req.params.id || ""));
    if (!job) return sendError(res, 404, "Job not found");
    return sendOk(res, job);
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const ok = cancelJob(String(req.params.id || ""));
    if (!ok) return sendError(res, 404, "Job not found or not cancellable");
    return sendOk(res, { cancelled: true });
  });
}
