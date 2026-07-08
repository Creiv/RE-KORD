// @vitest-environment node
import { describe, expect, it } from "vitest";
import { enqueueJob, cancelJob, getJob, listJobs } from "../jobs/queue.mjs";

describe("job queue", () => {
  it("runs and completes a job", async () => {
    const id = enqueueJob("library_scan", async ({ setProgress }) => {
      setProgress(50, "half");
      setProgress(100, "done");
    });
    await new Promise((r) => setTimeout(r, 20));
    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(listJobs().some((j) => j.id === id)).toBe(true);
  });

  it("cancels pending job", async () => {
    const id = enqueueJob("enrichment", async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });
    expect(cancelJob(id)).toBe(true);
    expect(getJob(id)?.status).toBe("cancelled");
  });
});
