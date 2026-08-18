<script lang="ts">
  import { Button, EmptyState, Panel } from "@rekord/ui";
  import { admin, humanTime } from "../lib/admin.svelte";

  const jobs = $derived(admin.jobs);
  const finished = $derived(jobs.filter((j) => j.status !== "running").length);

  const statusLabel: Record<string, string> = {
    running: "in corso",
    done: "completato",
    failed: "errore",
    canceled: "annullato",
  };
</script>

<Panel title="Operazioni in corso">
  {#snippet actions()}
    <Button variant="secondary" disabled={admin.busy} onclick={() => void admin.loadSection("jobs")}>
      Aggiorna
    </Button>
    <Button
      variant="ghost"
      disabled={admin.busy || finished === 0}
      onclick={() => void admin.clearJobs()}
    >
      Pulisci storico
    </Button>
  {/snippet}

  {#if jobs.length === 0}
    <EmptyState message="Nessuna operazione registrata" />
  {:else}
    <ul class="jobs">
      {#each jobs as job (job.id)}
        <li class="job" data-status={job.status}>
          <div class="head">
            <span class="label">{job.label}</span>
            <span class="status">{statusLabel[job.status] ?? job.status}</span>
          </div>
          {#if job.status === "running"}
            <div
              class="bar"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.round((job.progress ?? 0) * 100)}
            >
              <div class="fill" style="width: {Math.round((job.progress ?? 0) * 100)}%"></div>
            </div>
          {/if}
          <div class="meta">
            <span>{job.message ?? job.error ?? "—"}</span>
            <span class="when">
              {humanTime(job.finishedAt ?? job.createdAt)}
            </span>
          </div>
          {#if job.status === "running" && job.cancelable}
            <Button
              variant="ghost"
              disabled={admin.busy}
              onclick={() => void admin.cancelJob(job.id)}
            >
              Annulla
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .jobs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .job {
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    background: var(--rk-surface-3);
    padding: 0.65rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .label {
    font-weight: 650;
  }

  .status {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .job[data-status="running"] .status {
    color: var(--rk-accent);
  }

  .job[data-status="failed"] .status {
    color: var(--rk-danger, #f87171);
  }

  .bar {
    height: 5px;
    border-radius: var(--rk-radius-round);
    background: color-mix(in srgb, var(--rk-line) 70%, transparent);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--rk-accent), var(--rk-accent-2));
    transition: width 180ms ease;
  }

  .meta {
    display: flex;
    justify-content: space-between;
    gap: 0.7rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
    min-width: 0;
  }

  .meta span {
    overflow-wrap: anywhere;
  }

  .when {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
</style>
