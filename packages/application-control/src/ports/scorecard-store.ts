import type { ScorecardRecord, ScorecardStatus } from "@everdict/contracts";

// list filter — narrows dataset/harness/status in the store (SQL) so leaderboard/trend don't scan the whole workspace.
// If unset, everything (current behavior). Summary-derived axes like model/judgeModel are still filtered in the service/suite (can't narrow in SQL).
export interface ScorecardListFilter {
  dataset?: string; // dataset.id
  harness?: string; // harness.id
  status?: ScorecardStatus;
  judge?: string; // applied Agent Judge id (orchestration.judges[].id, any version) — the judge detail's evaluation history
}

// Scorecard store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
// Note: list intentionally omits the heavy `scorecard` (trace-included) field (summary only). Get the full thing via get.
export interface ScorecardStore {
  create(record: ScorecardRecord): Promise<void>;
  update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]>;
  // Hard delete (scorecards are result records, not versioned reproducibility artifacts — no tombstone).
  // Returns false when the id doesn't exist. Tenant scoping is the service's job (get-then-check, like cancel).
  delete(id: string): Promise<boolean>;
}
