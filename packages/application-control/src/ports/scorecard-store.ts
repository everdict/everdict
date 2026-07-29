import type { ScorecardRecord, ScorecardStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// list filter — narrows dataset/harness/status in the store (SQL) so leaderboard/trend don't scan the whole workspace.
// If unset, everything (current behavior). Summary-derived axes like model/judgeModel are still filtered in the service/suite (can't narrow in SQL).
export interface ScorecardListFilter {
  dataset?: string; // dataset.id
  harness?: string; // harness.id
  status?: ScorecardStatus;
  judge?: string; // applied Agent Judge id (orchestration.judges[].id, any version) — the judge detail's evaluation history
  scheduleId?: string; // the schedule that fired the run (origin.scheduleId) — the schedule detail's run history
  // Cascade-cancel walk (§5.5): the batches a given run caused (origin.causedByRunId) — the kill switch's read.
  causedByRunId?: string;
  // Group kind (P1): "experiment" = only ungraded phase-1 groups; "scorecard" = only real scorecards (incl. every
  // pre-mig-0093 NULL row). Unset = everything (current behavior — the web list shows both, badged).
  kind?: "experiment" | "scorecard";
}

// Scorecard store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
// Note: list intentionally omits the heavy `scorecard` (trace-included) field (summary only). Get the full thing via get.
// `events`: E0 outbox rows (stamped facts from the aggregate transition) persisted ATOMICALLY with the write —
// same contract as RunStore. A call site that passes none keeps its pre-outbox silence.
export interface ScorecardStore {
  create(record: ScorecardRecord, events?: OutboxEvent[]): Promise<void>;
  update(id: string, patch: Partial<ScorecardRecord>, events?: OutboxEvent[]): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]>;
  // Hard delete (scorecards are result records, not versioned reproducibility artifacts — no tombstone).
  // Returns false when the id doesn't exist. Tenant scoping is the service's job (get-then-check, like cancel).
  delete(id: string): Promise<boolean>;
}
