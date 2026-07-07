import type { AgentJob, CaseResult } from "@everdict/core";

// Activity signatures the workflow calls (pure types — safely imported into the workflow bundle).
export interface Activities {
  dispatchCase(job: AgentJob): Promise<CaseResult>;
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
}
