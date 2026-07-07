import type { AgentJob, CaseResult } from "@everdict/core";
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { Activities } from "./types.js";

// ⚠ Workflow code must be deterministic — no I/O, import types only.
// The actual backend dispatch happens in the activity (dispatchCase) (retry/timeout capable).
const { dispatchCase } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour", // Nomad alloc + claude execution can be long
  retry: { maximumAttempts: 3 },
});

// Scheduled fire/poll/finalize activities — internal HTTP routes, so a short timeout.
const { fireScheduledScorecard, scheduledScorecardStatus, finalizeScheduledScorecard } = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// One case = a durable workflow execution. Resumes even if the control plane dies.
export async function evalCaseWorkflow(job: AgentJob): Promise<CaseResult> {
  return dispatchCase(job);
}

// Workflow-level fan-out cap — keeps a large suite from occupying all activity slots at once.
// (Fine-grained cluster capacity gating is additionally done by the worker's Scheduler.)
const SUITE_FANOUT = 8;

// Suite = dispatch multiple cases with a bounded fan-out (each activity retries independently).
// Deterministic: lane workers grab an index via a shared counter and fill results by index (Temporal replay-safe).
export async function suiteWorkflow(jobs: AgentJob[]): Promise<CaseResult[]> {
  const results = new Array<CaseResult>(jobs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      if (job === undefined) continue;
      results[i] = await dispatchCase(job);
    }
  };
  const lanes = Math.max(1, Math.min(SUITE_FANOUT, jobs.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

// Scheduled (cron) fire workflow — the Temporal Schedule starts it on each cron tick (TemporalScheduleDriver).
// After fire (scorecard submit), poll until completion — the workflow lifetime must equal the actual scorecard lifetime so the Schedule's
// overlap policy (Skip/BufferOne) is meaningful (submit returns queued immediately, so fire-and-forget would be pointless).
// Design: docs/architecture/scheduled-evals.md.
const POLL_INTERVAL_MS = 30_000;
const MAX_POLLS = 480; // ~4-hour cap (30s × 480) — prevents indefinite waiting

export async function scheduledScorecardWorkflow(input: { scheduleId: string; tenant: string }): Promise<void> {
  const { scorecardId, previousScorecardId } = await fireScheduledScorecard(input);
  for (let i = 0; i < MAX_POLLS; i++) {
    const status = await scheduledScorecardStatus(scorecardId);
    if (status === "succeeded" || status === "failed") {
      // Completion → record the final status + alert on regression vs the previous run (finalize). Then the workflow ends.
      await finalizeScheduledScorecard({
        scheduleId: input.scheduleId,
        tenant: input.tenant,
        scorecardId,
        ...(previousScorecardId !== undefined ? { previousScorecardId } : {}),
      });
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
