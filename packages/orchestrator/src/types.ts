import type { CaseJob, CaseResult } from "@everdict/contracts";

// Activity signatures the workflow calls (pure types — safely imported into the workflow bundle).
export interface Activities {
  dispatchCase(job: CaseJob): Promise<CaseResult>;
  // Scheduled fire — submit a scorecard via the control-plane internal route (the worker has no ScorecardService, so an HTTP bridge).
  // A report-mode fire completes inside the activity and returns no scorecardId (the workflow ends without polling).
  fireScheduledScorecard(input: { scheduleId: string; tenant: string }): Promise<{ scorecardId?: string }>;
  // Poll the fired scorecard's status (workflow poll-to-terminal — so the overlap policy is meaningful).
  scheduledScorecardStatus(scorecardId: string): Promise<string | null>;
  // Finalization — record the fired scorecard's terminal status on the schedule (internal route → ScheduleService.finalize).
  finalizeScheduledScorecard(input: { scheduleId: string; tenant: string; scorecardId: string }): Promise<void>;

  // --- Batch-on-Temporal (docs/architecture/temporal-batch-orchestration.md) ---
  // The control plane owns execution/scoring/streaming (same internal-bridge pattern as scheduled fires — no logic
  // forks); the workflow owns the DRIVER LOOP's durability. planBatch resolves the remaining case ids (idempotent —
  // a re-attached workflow gets only what is still unfinished), runBatchCase executes+settles exactly one case
  // (idempotent — an already-settled case returns skipped), finalizeBatch aggregates and persists the record.
  planBatch(input: { scorecardId: string }): Promise<{ caseIds: string[]; concurrency: number }>;
  runBatchCase(input: { scorecardId: string; caseId: string }): Promise<{ settled: boolean; skipped?: boolean }>;
  finalizeBatch(input: { scorecardId: string }): Promise<void>;

  // --- Score-on-Temporal (orchestration.md T-c, `score:<groupId>`) — the detached phase-2 pass as a durable
  // workflow, same internal-bridge pattern as the batch. prepareScore runs ONCE per pass (strip-first: clears
  // the selected judges' prior rows so the plan's id-only measured predicate means "judged in THIS pass" —
  // without it a new-VERSION re-score planned empty and finalized over the old version's judgments; the strip
  // itself is idempotent for activity retries). planScore is idempotent (child keys still missing a selected
  // judge's verdict — a resumed/continued pass gets exactly the remainder), scoreGroupCase judges ONE
  // (case, trial) child and writes back (already-judged → skipped), finalizeScore re-aggregates and settles. ---
  prepareScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
    // The pass this workflow owns (arch-review 8 P0) — presented on every write so a superseded
    // activity is refused instead of mutating the plane a newer pass is certifying.
    passId?: string;
  }): Promise<{ stripped: number }>;
  planScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
    // The pass this workflow owns (arch-review 8 P0) — presented on every write so a superseded
    // activity is refused instead of mutating the plane a newer pass is certifying.
    passId?: string;
  }): Promise<{ keys: string[]; concurrency: number }>;
  scoreGroupCase(input: {
    groupId: string;
    key: string;
    judges: Array<{ id: string; version: string }>;
    submittedBy?: string;
    // The pass this workflow owns (arch-review 8 P0) — presented on every write so a superseded
    // activity is refused instead of mutating the plane a newer pass is certifying.
    passId?: string;
  }): Promise<{ scored: boolean; skipped?: boolean }>;
  finalizeScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
    submittedBy?: string;
    // The pass this workflow owns (arch-review 8 P0) — presented on every write so a superseded
    // activity is refused instead of mutating the plane a newer pass is certifying.
    passId?: string;
  }): Promise<void>;
  // The pass's DEATH NOTICE (arch-review 10 P1). A workflow that fails terminally — retries exhausted, a
  // non-retryable activity error, a worker termination — used to just stop, leaving a marker that still said
  // `running` over a plane the pass had already stripped. Readers then refused for a full lease, and the
  // takeover had to infer death from a clock; the workflow knew, and had no way to say so. This is the
  // saying. Best-effort and idempotent by contract, fenced on `passId` so a workflow that died BECAUSE it
  // was superseded cannot declare its successor's live pass dead.
  failScore(input: { groupId: string; passId: string; reason: string }): Promise<{ marked: boolean }>;

  // --- Durable approvals (orchestration.md T-a, `approval:<id>`) — the workflow owns ONLY the days-long
  // WAIT; park/decide/deliver live on the CP. expireApproval is the deny-on-expiry (idempotent: an
  // already-decided record skips silently on the CP side). ---
  expireApproval(input: { approvalId: string; tenant: string }): Promise<void>;
  // --- Durable session reaper (T-b): teardown-on-deadline for a sandbox session run. Idempotent: a
  // settled row skips; a row whose handle died with an earlier CP settles as orphaned and its stray
  // container is removed by the recorded compute id. ---
  reapSession(input: { runId: string; tenant: string }): Promise<void>;

  // --- Durable multi-step reactions (orchestration.md T-d, `reaction:<eventId>:<subscriptionId>`) — the
  // workflow owns the CHAIN (start step N, wait out its run, then N+1); each step is one agent activation
  // over the CP → agent-service internal bridge. startReactionStep is idempotent (the durable
  // (agent, step-key) dedup returns the existing session on a retry); a busy agent queue is a THROWN
  // transient (Temporal retries), a permanently unrunnable step returns {skipped}. ---
  startReactionStep(input: {
    tenant: string;
    agentId: string;
    eventId: string; // the step's dedup key (`<eventId>#s<i>`)
    subscriptionId: string;
    eventKind: string;
    message: string;
    payload?: Record<string, unknown>;
    subject?: { type: string; id: string };
    instruction?: string;
  }): Promise<{ sessionId: string } | { skipped: string }>;
  reactionStepStatus(input: { tenant: string; sessionId: string }): Promise<{ status: string }>;
}
