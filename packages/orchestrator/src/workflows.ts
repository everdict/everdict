import type { CaseJob, CaseResult } from "@everdict/contracts";
import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
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
export async function evalCaseWorkflow(job: CaseJob): Promise<CaseResult> {
  return dispatchCase(job);
}

// Workflow-level fan-out cap — keeps a large suite from occupying all activity slots at once.
// (Fine-grained cluster capacity gating is additionally done by the worker's Scheduler.)
const SUITE_FANOUT = 8;

// Suite = dispatch multiple cases with a bounded fan-out (each activity retries independently).
// Deterministic: lane workers grab an index via a shared counter and fill results by index (Temporal replay-safe).
export async function suiteWorkflow(jobs: CaseJob[]): Promise<CaseResult[]> {
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

// Batch workflow — one scorecard batch = one durable workflow (docs/architecture/temporal-batch-orchestration.md).
// The control plane executes+settles each case via the internal bridge; this loop only owns durability: if the CP
// dies mid-case the activity retries against the restarted CP, if the WORKER dies another worker replays the
// history and picks up exactly where it stopped. Case-level transient retry (failure classes) lives CP-side —
// the generous activity retry here is for TRANSPORT failures (CP unreachable), not eval semantics.
const batchActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour",
  retry: { maximumAttempts: 10, initialInterval: "5s", maximumInterval: "1 minute" },
});

// The reaper's teardown must not give up while the control plane is down — that outage is exactly the case
// the durable reaper exists for. Unlimited attempts, capped backoff: the leak ends when a CP is back.
const reaperActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "5s", maximumInterval: "5 minutes" },
});

// Workflow-side lane cap — the CP's own concurrency figure drives lanes (bounded, deterministic counter pattern).
const MAX_BATCH_LANES = 64;

// Settled cases per workflow execution before continue-as-new. Each case is ~a handful of history events
// (activity scheduled/started/completed, × transport retries), so an unbounded 5,000-case batch would walk into
// Temporal's history limits (50K events / 50MB). planBatch is idempotent (unfinished-only), which makes
// continue-as-new trivially correct: the continued execution re-plans and picks up exactly the remainder with a
// FRESH history. Overridable per start (input.continueEvery — the CP driver reads its env).
const BATCH_CONTINUE_EVERY = 500;

// History-pressure rotation floor (ADAPTIVE continue-as-new). The fixed case-count slice assumes ~a handful of
// events per case, but activity transport retries inflate events-per-case — a flaky network can walk a
// 500-case slice into the history limits anyway. Rotate on the SERVER's own continueAsNewSuggested signal, with
// this event-count floor as belt-and-braces for servers that don't set it. planBatch's idempotent re-plan makes
// an early rotation harmless (the continuation picks up exactly the remainder).
const HISTORY_ROTATE_AT = 20_000;

export async function scorecardBatchWorkflow(input: {
  scorecardId: string;
  continueEvery?: number;
  rotateAtHistoryLength?: number;
}): Promise<void> {
  const plan = await batchActivities.planBatch({ scorecardId: input.scorecardId });
  const limit = Math.max(1, input.continueEvery ?? BATCH_CONTINUE_EVERY);
  const rotateAt = Math.max(1, input.rotateAtHistoryLength ?? HISTORY_ROTATE_AT);
  // Only this slice runs in THIS execution — the rest belongs to the continued one.
  const ids = plan.caseIds.slice(0, limit);
  let next = 0;
  let rotatedEarly = false;
  const lane = async (): Promise<void> => {
    while (next < ids.length) {
      // History pressure — stop TAKING new cases and drain in-flight lanes; the continued execution re-plans.
      // workflowInfo() is deterministic (replay reads the recorded history), so this is replay-safe.
      const info = workflowInfo();
      if (info.continueAsNewSuggested || info.historyLength >= rotateAt) {
        rotatedEarly = true;
        return;
      }
      const i = next++;
      const caseId = ids[i];
      if (caseId === undefined) continue;
      await batchActivities.runBatchCase({ scorecardId: input.scorecardId, caseId });
    }
  };
  const lanes = Math.max(1, Math.min(plan.concurrency, MAX_BATCH_LANES, ids.length || 1));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (rotatedEarly || plan.caseIds.length > limit) {
    await continueAsNew<typeof scorecardBatchWorkflow>(input); // ends this execution — the chain continues under the same workflowId
    return;
  }
  await batchActivities.finalizeBatch({ scorecardId: input.scorecardId });
}

// Detached phase-2 scoring as a durable workflow (orchestration.md T-c, workflowId `everdict-score-<groupId>`).
// The CP owns judging/aggregation (internal bridge); the workflow owns ONLY the pass's durability: kill the CP
// mid-pass and the activities retry against the restarted CP; kill the worker and another replays the history.
// Zero duplicate judging on resume comes from planScore's idempotence (unfinished-only) + scoreGroupCase's
// skip-if-judged — the same two properties that make continue-as-new trivially correct here.
const SCORE_CONTINUE_EVERY = 500;
const SCORE_ROTATE_AT = 20_000;
const MAX_SCORE_LANES = 16; // judging is model calls, not sandboxes — a tighter lane cap than the batch

export async function scoreGroupWorkflow(input: {
  groupId: string;
  judges: Array<{ id: string; version: string }>;
  submittedBy?: string;
  continueEvery?: number;
  rotateAtHistoryLength?: number;
}): Promise<void> {
  const plan = await batchActivities.planScore({ groupId: input.groupId, judges: input.judges });
  const limit = Math.max(1, input.continueEvery ?? SCORE_CONTINUE_EVERY);
  const rotateAt = Math.max(1, input.rotateAtHistoryLength ?? SCORE_ROTATE_AT);
  const keys = plan.keys.slice(0, limit);
  let next = 0;
  let rotatedEarly = false;
  const lane = async (): Promise<void> => {
    while (next < keys.length) {
      const info = workflowInfo();
      if (info.continueAsNewSuggested || info.historyLength >= rotateAt) {
        rotatedEarly = true;
        return;
      }
      const i = next++;
      const key = keys[i];
      if (key === undefined) continue;
      await batchActivities.scoreGroupCase({
        groupId: input.groupId,
        key,
        judges: input.judges,
        ...(input.submittedBy !== undefined ? { submittedBy: input.submittedBy } : {}),
      });
    }
  };
  const lanes = Math.max(1, Math.min(plan.concurrency, MAX_SCORE_LANES, keys.length || 1));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (rotatedEarly || plan.keys.length > limit) {
    await continueAsNew<typeof scoreGroupWorkflow>(input);
    return;
  }
  await batchActivities.finalizeScore({
    groupId: input.groupId,
    judges: input.judges,
    ...(input.submittedBy !== undefined ? { submittedBy: input.submittedBy } : {}),
  });
}

// Durable approval WAIT (orchestration.md T-a, workflowId `everdict-approval-<id>`): park → wait for the
// decision signal or the days-long timer → deny-on-expiry. Done = approved | denied | expired. The agent
// loop stays in the agent service and the ledger stays on the CP — this workflow owns ONLY the wait, which
// is exactly the piece an in-process park could never make restart-proof. The decide route signals for a
// prompt completion, but correctness never depends on it: expireApproval skips an already-decided record,
// so a missed signal merely lets the timer fire a no-op at TTL.
export const approvalDecidedSignal = defineSignal("decided");

export async function approvalWorkflow(input: {
  approvalId: string;
  tenant: string;
  timeoutMs: number;
}): Promise<void> {
  let decided = false;
  setHandler(approvalDecidedSignal, () => {
    decided = true;
  });
  const settledInTime = await condition(() => decided, Math.max(1, input.timeoutMs));
  if (!settledInTime) await batchActivities.expireApproval({ approvalId: input.approvalId, tenant: input.tenant });
}

// Durable session reaper (orchestration.md T-b, workflowId `everdict-reaper-<runId>`): sleep to the hard
// deadline, then tear the session down over the internal bridge — "the reaper is the finally", made
// crash-proof (a control plane dying with the live handle no longer leaks the container or the row: the
// activity retries until a control plane is back to serve it). The close path signals for a prompt
// completion; correctness never depends on it — reap skips an already-settled record.
export const reaperClosedSignal = defineSignal("closed");

export async function sessionReaperWorkflow(input: {
  runId: string;
  tenant: string;
  timeoutMs: number;
}): Promise<void> {
  let closed = false;
  setHandler(reaperClosedSignal, () => {
    closed = true;
  });
  const closedInTime = await condition(() => closed, Math.max(1, input.timeoutMs));
  if (!closedInTime) await reaperActivities.reapSession({ runId: input.runId, tenant: input.tenant });
}

export async function scheduledScorecardWorkflow(input: { scheduleId: string; tenant: string }): Promise<void> {
  const { scorecardId } = await fireScheduledScorecard(input);
  // A report-mode fire completes synchronously inside the fire activity (no scorecard) — nothing to poll/finalize.
  if (scorecardId === undefined) return;
  for (let i = 0; i < MAX_POLLS; i++) {
    const status = await scheduledScorecardStatus(scorecardId);
    if (status === "succeeded" || status === "failed") {
      // Completion → record the fired scorecard's terminal status on the schedule (finalize). Then the workflow ends.
      await finalizeScheduledScorecard({ scheduleId: input.scheduleId, tenant: input.tenant, scorecardId });
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
