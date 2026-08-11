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
import { type ScoreRoundState, decideScoreRound } from "./score-round.js";
import type { Activities } from "./types.js";

// ⚠ Workflow code must be deterministic — no I/O, import types only.
// The actual backend dispatch happens in the activity (dispatchCase) (retry/timeout capable).
const { dispatchCase } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour", // Nomad alloc + claude execution can be long
  // …and WITHOUT this, that hour was also the detection latency for a dead worker (arch-review 26, found by
  // TRUST-140). Temporal cannot tell "still working" from "the machine is gone" except by a heartbeat, so a
  // case lost mid-dispatch sat silent until start-to-close expired. The activity beats every 10s; a minute of
  // silence is a death, and the case is retried on a live worker instead of an hour later.
  heartbeatTimeout: "1 minute",
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
  // The same reason `dispatchCase` has one (arch-review 27 P1): this request holds open for a whole eval
  // case, so without a heartbeat the hour it is allowed to take is also the hour before Temporal will admit
  // the worker running it is gone. This is the path production drives — fixing only the primitive left the
  // seam that matters with the old latency.
  heartbeatTimeout: "1 minute",
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
// The pass STRIPS FIRST (prepareScore, once per pass): the plan's measured predicate is id-only — the score
// plane cannot represent a judge VERSION — so with the old version's verdicts still in place a re-score at a
// new version planned an empty worklist and finalized over judgments it never made. The `prepared` flag
// threads through continue-as-new because a later execution re-running the strip would erase THIS pass's own
// completed work. Zero duplicate judging on resume comes from planScore's idempotence (unfinished-only) +
// scoreGroupCase's skip-if-judged — the same two properties that make continue-as-new trivially correct here.
const SCORE_CONTINUE_EVERY = 500;
const SCORE_ROTATE_AT = 20_000;
const MAX_SCORE_LANES = 16; // judging is model calls, not sandboxes — a tighter lane cap than the batch

export async function scoreGroupWorkflow(input: {
  groupId: string;
  judges: Array<{ id: string; version: string }>;
  submittedBy?: string;
  // The pass this workflow OWNS (arch-review 8 P0), minted by the claim that started it. Carried through
  // continue-as-new, so a rotated workflow is still the same pass — and presented on every activity, so the
  // control plane can refuse the activities of a pass that was superseded while this history was rotating.
  // Absent = a workflow started before passes had identity: it adopts the live marker (its deterministic
  // workflow id made it the only starter) but may never mint one.
  passId?: string;
  prepared?: boolean; // set by continue-as-new — the strip already ran for this pass
  // The pass-global LOGICAL ROUND ordinal (mig 0159, corrected by arch-review 16 P0-1). Temporal's activity
  // `attempt` is monotonic only within one activity execution, and every replan round — rotation or not —
  // schedules a NEW execution that starts at attempt 1. So the ordinal must advance per ROUND; rotation
  // merely carries it. Carried in the INPUT so it stays deterministic: deriving it from workflow state
  // would not be.
  round?: number;
  // The pre-arch-review-16 name for the same carrier, when it meant "rotation count". Read once so a
  // workflow that rotated under the old code keeps a MONOTONIC ordinal across the deploy — dropping to 0
  // would make its next round lose to its own staged claims.
  generation?: number;
  // The replan loop's own termination state, carried across rotation (arch-review 15 P1-6). `remainingAtLastPlan`
  // is the worklist size this pass last planned; `stalledRounds` counts consecutive rounds that failed to
  // shrink it. Both live in the INPUT because a rotation must not reset a stall counter — a pass that cannot
  // make progress would otherwise loop forever by simply rotating between the two rounds of the guard.
  remainingAtLastPlan?: number;
  stalledRounds?: number;
  continueEvery?: number;
  rotateAtHistoryLength?: number;
}): Promise<void> {
  // A pass that dies must SAY it died (arch-review 10 P1). Without this the marker keeps reading `running`
  // over a plane the strip already mutated, and "still working" is indistinguishable from "dead since
  // Tuesday" until the lease runs out. The notice is fenced on this pass's own id, so a workflow that failed
  // BECAUSE a takeover superseded it finds the marker belongs to its successor and correctly marks nothing.
  //
  // `continueAsNew` is deliberately OUTSIDE this guard: the SDK signals rotation by throwing, and catching
  // that would turn every rotation of a long pass into a death notice against a perfectly live pass.
  const announceDeath = async (err: unknown): Promise<void> => {
    if (input.passId === undefined) return; // a pre-identity workflow has no pass to fence the notice on
    await batchActivities.failScore({
      groupId: input.groupId,
      passId: input.passId,
      reason: `the scoring workflow failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  };
  // PLAN → EXECUTE → REPLAN (arch-review 15 P1-6). A pass finishes when the worklist is EMPTY, which is a
  // question only a fresh plan can answer — so every round asks it. The round's decision (finish / rotate /
  // abandon / execute) is the pure `decideScoreRound`, so the rule that used to be implicit in a `>` against
  // the batch size is stated once and unit-tested without a Temporal test environment.
  let rotatedEarly = false;
  let state: ScoreRoundState = {
    ...(input.remainingAtLastPlan !== undefined ? { remaining: input.remainingAtLastPlan } : {}),
    stalled: input.stalledRounds ?? 0,
    round: input.round ?? input.generation ?? 0,
  };
  // Cases the pass gave up re-planning (the stall guard fired) — carried to finalize so the record can say it.
  let abandoned = 0;
  // Cases driven by THIS execution — the slice budget, which is really a history budget.
  let executed = 0;
  const limit = Math.max(1, input.continueEvery ?? SCORE_CONTINUE_EVERY);
  const rotateAt = Math.max(1, input.rotateAtHistoryLength ?? SCORE_ROTATE_AT);
  // workflowInfo() is deterministic (replay reads the recorded history), so this is replay-safe.
  const rotationDue = (): boolean => {
    const info = workflowInfo();
    return info.continueAsNewSuggested || info.historyLength >= rotateAt;
  };
  try {
    if (!input.prepared)
      await batchActivities.prepareScore({
        groupId: input.groupId,
        judges: input.judges,
        ...(input.passId !== undefined ? { passId: input.passId } : {}),
      });
    let running = true;
    while (running) {
      const plan = await batchActivities.planScore({
        groupId: input.groupId,
        judges: input.judges,
        ...(input.passId !== undefined ? { passId: input.passId } : {}),
      });
      const decision = decideScoreRound(plan.keys, state, rotationDue(), limit);
      if (decision.kind === "finish") break;
      if (decision.kind === "abandon") {
        abandoned = decision.abandoned;
        break;
      }
      if (decision.kind === "rotate") {
        state = decision.state;
        rotatedEarly = true;
        break;
      }
      state = decision.state;
      const keys = decision.keys;
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < keys.length) {
          // History pressure — stop TAKING new cases and drain in-flight lanes; the continuation re-plans.
          if (rotationDue()) {
            rotatedEarly = true;
            running = false;
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
            ...(input.passId !== undefined ? { passId: input.passId } : {}),
            // THIS ROUND's ordinal — advanced by the decision above, so a fresh activity execution in a
            // later round outranks the previous round's exhausted attempts instead of losing to them.
            generation: state.round,
          });
        }
      };
      const lanes = Math.max(1, Math.min(plan.concurrency, MAX_SCORE_LANES, keys.length || 1));
      await Promise.all(Array.from({ length: lanes }, () => lane()));
      executed += keys.length;
      // The slice budget is a HISTORY budget, and it stays one: an execution rotates once it has driven
      // `limit` cases, exactly as before. What changed is only what happens NEXT — the continuation re-plans,
      // instead of the pass deciding it is finished because the batch happened to fit in one slice.
      if (executed >= limit) {
        rotatedEarly = true;
        break;
      }
    }
  } catch (err) {
    await announceDeath(err);
    throw err;
  }
  if (rotatedEarly) {
    // The stall state rides along, so rotating cannot launder a pass that is making no progress into a fresh
    // budget — and so does the round ordinal, which is what keeps the claim monotonic across the boundary.
    await continueAsNew<typeof scoreGroupWorkflow>({
      ...input,
      prepared: true,
      // Rotation CARRIES the round; it no longer defines one. The continuation's first execute decision
      // advances it, exactly as an in-execution replan does — one rule for both.
      round: state.round,
      ...(state.remaining !== undefined ? { remainingAtLastPlan: state.remaining } : {}),
      stalledRounds: state.stalled,
    });
    return;
  }
  try {
    await batchActivities.finalizeScore({
      groupId: input.groupId,
      judges: input.judges,
      ...(input.submittedBy !== undefined ? { submittedBy: input.submittedBy } : {}),
      ...(input.passId !== undefined ? { passId: input.passId } : {}),
      ...(abandoned > 0 ? { abandoned } : {}),
    });
  } catch (err) {
    await announceDeath(err);
    throw err;
  }
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
// Touch (agent worlds W1): the CP pushed the session's deadline out. The signal carries the NEW remaining
// time, computed control-plane-side at send — the workflow re-arms its timer without ever reading a clock
// (determinism holds). Several touches racing one sleep keep the largest extension.
export const reaperExtendSignal = defineSignal<[number]>("extend");

export async function sessionReaperWorkflow(input: {
  runId: string;
  tenant: string;
  timeoutMs: number;
}): Promise<void> {
  let closed = false;
  let extendedMs = 0;
  setHandler(reaperClosedSignal, () => {
    closed = true;
  });
  setHandler(reaperExtendSignal, (remainingMs: number) => {
    extendedMs = Math.max(extendedMs, remainingMs);
  });
  let remaining = input.timeoutMs;
  for (;;) {
    await condition(() => closed || extendedMs > 0, Math.max(1, remaining));
    if (closed) return;
    if (extendedMs > 0) {
      remaining = extendedMs;
      extendedMs = 0;
      continue;
    }
    break; // the deadline fired with no extension pending — reap
  }
  await reaperActivities.reapSession({ runId: input.runId, tenant: input.tenant });
}

// Reaction activities: the step START must not give up while the control plane or the agent service is
// down — the durable chain exists exactly for those outages. Capped-backoff unlimited retry; the poll is
// cheap and frequent, so its failures just ride the next attempt.
const reactionActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "5s", maximumInterval: "5 minutes" },
});

// Durable multi-step reaction (orchestration.md T-d, workflowId `everdict-reaction-<eventId>-<subscriptionId>`):
// walk the subscription's steps — start ONE agent run per step over the internal bridge, wait out its
// session (poll under a per-step budget; awaiting_approval counts as alive — a HITL park mid-chain is
// exactly what durability is for), and only then advance. A failed/cancelled/timed-out step ends the chain
// (the runs themselves already narrate the outcome on the event log — the workflow adds no judgment).
export async function reactionWorkflow(input: {
  eventId: string;
  tenant: string;
  subscriptionId: string;
  steps: Array<{ agentId: string; instruction?: string }>;
  eventKind: string;
  message: string;
  payload?: Record<string, unknown>;
  subject?: { type: string; id: string };
  pollSeconds?: number; // default 30s
  stepTimeoutMs?: number; // per-step watch budget (default 2h)
}): Promise<{ completed: number; outcome: "completed" | "step_skipped" | "step_failed" | "step_timeout" }> {
  const pollMs = Math.max(1000, (input.pollSeconds ?? 30) * 1000);
  const budgetMs = input.stepTimeoutMs ?? 7_200_000;
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    if (!step) break;
    const started = await reactionActivities.startReactionStep({
      tenant: input.tenant,
      agentId: step.agentId,
      eventId: `${input.eventId}#s${i}`,
      subscriptionId: input.subscriptionId,
      eventKind: input.eventKind,
      message: input.message,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(step.instruction !== undefined ? { instruction: step.instruction } : {}),
    });
    if ("skipped" in started) return { completed: i, outcome: "step_skipped" };
    let status = "pending";
    for (let waitedMs = 0; waitedMs < budgetMs; waitedMs += pollMs) {
      await sleep(pollMs);
      status = (await reactionActivities.reactionStepStatus({ tenant: input.tenant, sessionId: started.sessionId }))
        .status;
      if (status === "completed" || status === "failed" || status === "cancelled") break;
    }
    if (status !== "completed")
      return { completed: i, outcome: status === "failed" || status === "cancelled" ? "step_failed" : "step_timeout" };
  }
  return { completed: input.steps.length, outcome: "completed" };
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
