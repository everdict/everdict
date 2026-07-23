import type { RunRecord } from "@everdict/contracts";

// list options. The default (unset) returns only standalone runs — hides scorecard child runs to prevent activity-list flooding.
// With scorecardId, returns only that batch's child runs (for the case drill-down in scorecard detail).
// With includeChildren, returns standalone runs AND scorecard children together (the activity console's "all executions"
// view — the UI groups children under their scorecard). Ignored when scorecardId is set (that already targets one batch).
export interface RunListOptions {
  scorecardId?: string;
  includeChildren?: boolean;
  // Runs a given self-hosted runner executed (result.provenance.runner === runnerId) — the runner-detail activity
  // feed. Implies includeChildren (a runner mostly runs scorecard cases). Only completed runs carry provenance, so
  // this returns finished runs, newest first.
  runnerId?: string;
  // Cap the number of rows returned (newest first) — the activity feed only needs the recent slice. Unset = no cap.
  limit?: number;
  // Skip the first N rows (newest first) before applying limit — offset pagination for the runner-detail activity
  // feed (each page fetches exactly `limit` rows at `offset = page * limit`). Unset/0 = start from the newest.
  offset?: number;
}

// Result store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
  // Remove every child run a scorecard fanned out (scorecard hard-delete cascade — orphaned children would
  // otherwise linger in the "all executions" view). Returns the number of runs removed.
  deleteByScorecard(scorecardId: string): Promise<number>;
}
