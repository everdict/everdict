import type { RunRecord } from "@everdict/contracts";

// list options. The default (unset) returns only standalone runs — hides scorecard child runs to prevent activity-list flooding.
// With scorecardId, returns only that batch's child runs (for the case drill-down in scorecard detail).
// With includeChildren, returns standalone runs AND scorecard children together (the activity console's "all executions"
// view — the UI groups children under their scorecard). Ignored when scorecardId is set (that already targets one batch).
export interface RunListOptions {
  scorecardId?: string;
  includeChildren?: boolean;
}

// Result store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
}
