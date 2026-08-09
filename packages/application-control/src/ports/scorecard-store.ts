import type { ScorecardRecord, ScorecardStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// list filter — narrows dataset/harness/status in the store (SQL) so leaderboard/trend don't scan the whole workspace.
// If unset, everything (current behavior). Summary-derived axes like model/judgeModel are still filtered in the service/suite (can't narrow in SQL).
export interface ScorecardListFilter {
  dataset?: string; // dataset.id
  harness?: string; // harness.id
  status?: ScorecardStatus;
  // The owning team — "what has THIS team evaluated", the read the team page is.
  teamId?: string;
  // The teams the CALLER may see, which is a different question from the one above: `teamId` narrows to a team on
  // purpose, `visibleTeams` is the ceiling every read stays under. A batch owned by a team outside this list is not
  // returned at all (ownership isolates, it does not merely sort). Unowned batches (no `teamId` — `_shared` seeds,
  // rows from before the axis existed) belong to the whole workspace and are always kept. Unset = no ceiling: an
  // admin governs every team, and internal reads (recovery, cascade-cancel) are not acting for anyone.
  visibleTeams?: string[];
  judge?: string; // applied Agent Judge id (orchestration.judges[].id, any version) — the judge detail's evaluation history
  scheduleId?: string; // the schedule that fired the run (origin.scheduleId) — the schedule detail's run history
  // The product timeline's trend read (origin.productId / origin.seriesKey — docs/architecture/product-timeline.md):
  // "this product's batches over time", optionally narrowed to one watch series. The stamp is the x-axis key.
  productId?: string;
  seriesKey?: string;
  // Cascade-cancel walk (§5.5): the batches a given run caused (origin.causedByRunId) — the kill switch's read.
  causedByRunId?: string;
  // Group kind (P1): "experiment" = only ungraded phase-1 groups; "scorecard" = only real scorecards (incl. every
  // pre-mig-0093 NULL row). Unset = everything (current behavior — the web list shows both, badged).
  kind?: "experiment" | "scorecard";
}

// The append-only ledgers' optimistic guard (arch-review 7 P1, I5): `scoring` and `gates` are written as
// whole arrays, so two writers that both read [1] and write [1,2A] / [1,2B] silently LOSE an entry — a lost
// GateDecision is a governance-audit defect, a lost revision breaks scoring identity. A caller appending to
// either ledger states the length it read; the store commits ONLY if the persisted length still matches
// (WHERE jsonb_array_length guard on Pg, the same check in memory). A guard miss returns undefined exactly
// like a missing id — the caller just read the record, so undefined-under-guard IS the conflict signal
// (retry-reread for gates, refuse for a scoring settle). Append tables are the named longer-term shape.
export interface ScorecardUpdateGuard {
  expectScoringCount?: number;
  expectGatesCount?: number;
  // The scoring-pass FENCE (arch-review 9 P0): the pass that must still own the marker for this write to
  // commit. `passId` is a UUID and is never reused, which is what makes it a sound fencing token —
  // `expectScoringPassEpoch` alone was NOT, because a settle clears the marker and the next claim starts
  // the count over (1 → null → 1), so a stale writer's epoch could match a completely different pass.
  //  · a string → "the marker must still be this exact pass"
  //  · null     → "there must be no marker" (a fresh claim)
  expectScoringPassId?: string | null;
  // Take over ONLY a marker the DATABASE considers reclaimable — failed, or a lease that has expired against
  // the database's own clock. The service still decides WHETHER to attempt a takeover (it needs the reason
  // for its error message); this makes the database the authority on WHETHER IT MAY, so a fast replica
  // cannot shoot a healthy pass a slow one is still renewing.
  expectScoringPassReclaimable?: boolean;
  // The scoring-pass CLAIM's compare-and-swap (arch-review 8 P0). Claiming used to be read-check-write:
  // two replicas both read an absent marker, both decided they owned the pass, and the second write silently
  // replaced the first — a marker is not a lock. The claimant now states the epoch it OBSERVED and the store
  // commits only if the persisted marker still carries it, so exactly one claimant wins whatever the timing.
  //  · a number → "the marker I read had this epoch" (renewal, takeover of a reclaimable pass, settle)
  //  · null     → "there was no marker, or a legacy one with no epoch" (a fresh claim)
  // A miss returns undefined like a missing id — the caller just read the record, so it IS the conflict.
  // (diagnostic ordering, NOT the fence) — kept so a reader can see how many passes a record has had.
  expectScoringPassEpoch?: number | null;
  // ONE WRITE INSTRUCTION among the conditions, and it is here for the same reason they are: only the store
  // can execute it. The lease's END is stamped by the DATABASE (`now() + N seconds`), overwriting whatever
  // `leaseUntil` the patch carried.
  //
  // Why (arch-review 10 P1): `expectScoringPassReclaimable` already asks the database whether a lease has
  // expired, but the lease INSTANT was minted from the application's clock — so the two halves of one
  // decision were read off two different clocks. A replica running two minutes fast wrote leases that the
  // database considered expired on arrival, and its own healthy pass became reclaimable while it worked.
  // Producer and judge of an interval must share a clock; this makes them.
  stampScoringLeaseSeconds?: number;
}

// Scorecard store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
// Note: list intentionally omits the heavy `scorecard` (trace-included) field (summary only). Get the full thing via get.
// `events`: E0 outbox rows (stamped facts from the aggregate transition) persisted ATOMICALLY with the write —
// same contract as RunStore. A call site that passes none keeps its pre-outbox silence.
export interface ScorecardStore {
  create(record: ScorecardRecord, events?: OutboxEvent[]): Promise<void>;
  update(
    id: string,
    patch: Partial<ScorecardRecord>,
    events?: OutboxEvent[],
    guard?: ScorecardUpdateGuard,
  ): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]>;
  // Hard delete (scorecards are result records, not versioned reproducibility artifacts — no tombstone).
  // Returns false when the id doesn't exist. Tenant scoping is the service's job (get-then-check, like cancel).
  delete(id: string): Promise<boolean>;
}
