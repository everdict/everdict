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
  // workflow, same internal-bridge pattern as the batch. planScore is idempotent (child keys still missing a
  // selected judge's verdict — a resumed/continued pass gets exactly the remainder), scoreGroupCase judges ONE
  // (case, trial) child and writes back (already-judged → skipped), finalizeScore re-aggregates and settles. ---
  planScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
  }): Promise<{ keys: string[]; concurrency: number }>;
  scoreGroupCase(input: {
    groupId: string;
    key: string;
    judges: Array<{ id: string; version: string }>;
    submittedBy?: string;
  }): Promise<{ scored: boolean; skipped?: boolean }>;
  finalizeScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
    submittedBy?: string;
  }): Promise<void>;
}
