import type { CaseJob, CaseResult } from "@everdict/contracts";

// Activity signatures the workflow calls (pure types — safely imported into the workflow bundle).
export interface Activities {
  dispatchCase(job: CaseJob): Promise<CaseResult>;
  // Scheduled fire — submit a scorecard via the control-plane internal route (the worker has no ScorecardService, so an HTTP bridge).
  // Also receives the previous schedule run id (the regression baseline) and passes it to finalize.
  fireScheduledScorecard(input: {
    scheduleId: string;
    tenant: string;
  }): Promise<{ scorecardId: string; previousScorecardId?: string }>;
  // Poll the fired scorecard's status (workflow poll-to-terminal — so the overlap policy is meaningful).
  scheduledScorecardStatus(scorecardId: string): Promise<string | null>;
  // Finalization — record the final status + alert on regression vs the previous run (internal route → ScheduleService.finalize).
  finalizeScheduledScorecard(input: {
    scheduleId: string;
    tenant: string;
    scorecardId: string;
    previousScorecardId?: string;
  }): Promise<void>;

  // --- Batch-on-Temporal (docs/architecture/temporal-batch-orchestration.md) ---
  // The control plane owns execution/scoring/streaming (same internal-bridge pattern as scheduled fires — no logic
  // forks); the workflow owns the DRIVER LOOP's durability. planBatch resolves the remaining case ids (idempotent —
  // a re-attached workflow gets only what is still unfinished), runBatchCase executes+settles exactly one case
  // (idempotent — an already-settled case returns skipped), finalizeBatch aggregates and persists the record.
  planBatch(input: { scorecardId: string }): Promise<{ caseIds: string[]; concurrency: number }>;
  runBatchCase(input: { scorecardId: string; caseId: string }): Promise<{ settled: boolean; skipped?: boolean }>;
  finalizeBatch(input: { scorecardId: string }): Promise<void>;
}
