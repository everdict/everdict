import type { PublicationOperation, ScorecardRecord, ScorecardStatus } from "@everdict/contracts";
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
  // The publication sweep's read (arch-review 52, Wave 4): batches whose committed settlement still owes its
  // outward effects (`publication.state === "pending"`). Tenant-agnostic on purpose — the reconciler converges
  // rows nobody is asking about, so it sweeps the whole install and each row carries the tenant it acts for.
  publicationPending?: true;
  // Group kind (P1): "experiment" = only ungraded phase-1 groups; "scorecard" = only real scorecards (incl. every
  // pre-mig-0093 NULL row). Unset = everything (current behavior — the web list shows both, badged).
  kind?: "experiment" | "scorecard";

  // --- The list's own axes, so a narrowed screen narrows the READ -------------------------------------
  // These exist because a scorecard is an EVENT a CI run files, not a registry entry a human authors: the
  // collection only grows, and a screen that filters client-side over "everything" pays for the whole
  // history on every navigation. Each one mirrors a facet the list offers.
  runtime?: string; // placement target (registered runtime id | self:* runner)
  createdBy?: string; // the submitter subject
  // One calendar day of `created_at`, as `YYYY-MM-DD` **in UTC** — the stored instant's date, which is
  // exactly how the list's day grouping keys a row (`createdAt.slice(0, 10)`). A reader in another timezone
  // sees the same buckets the server counts; a locale-local day would make the header disagree with the page.
  day?: string;
  // Free text over what the list SEARCHES: the batch id and the two capability ids it names. Case-insensitive
  // substring — the same thing the in-browser search did while the whole collection was in hand.
  search?: string;

  // --- Paging ----------------------------------------------------------------------------------------
  // A bounded page in the store's own ordering (created_at DESC, id DESC). ABSENT = every match, which is
  // what every internal reader wants (boot recovery, the publication sweep, the cascade-cancel walk) and what
  // the HTTP list did for every caller until this existed. Adding it never changes an unbounded caller.
  limit?: number;
  // Keyset cursor: "strictly older than this row" in that same ordering. A row value rather than an OFFSET,
  // because an offset re-reads what it skipped and drifts by exactly one row for every batch submitted while
  // somebody pages — and new batches land at the head, which is the end the reader is paging away from.
  before?: { createdAt: string; id: string };
}

// The axes a batch can be grouped by — the list's own grouping vocabulary, answered by the store because a
// page cannot count what it does not hold. `day` is the UTC calendar day (see `ScorecardListFilter.day`).
export type ScorecardGroupBy = "day" | "status" | "harness" | "dataset" | "team" | "creator";

// `key` is null for the UNSET bucket (no team, no creator) — the same "unset" bucket the list draws last.
export interface ScorecardGroupCount {
  key: string | null;
  count: number;
}

// The bucket a batch falls under, as ONE function. The Postgres store necessarily says the same thing in SQL
// (`GROUP_KEY_SQL`), which is the one place two spellings are unavoidable and therefore the one place a parity
// test is owed; everything else — the in-memory store, every hand-written double — reads this, so a double
// cannot answer a count that disagrees with its own `list`.
// `day` is the UTC calendar day of the stored instant, which is exactly how the web keys a row for its day
// grouping: a header computed in one timezone over rows bucketed in another disagrees with itself twice a day.
export function scorecardGroupKey(record: ScorecardRecord, groupBy: ScorecardGroupBy): string | null {
  switch (groupBy) {
    case "day":
      return record.createdAt.slice(0, 10);
    case "status":
      return record.status;
    case "harness":
      return record.harness.id;
    case "dataset":
      return record.dataset.id;
    case "team":
      return record.teamId ?? null;
    case "creator":
      return record.createdBy ?? null;
  }
}

// Buckets with no rows are ABSENT, exactly as a SQL GROUP BY leaves them out — a caller that wants the empty
// columns of a closed vocabulary stands them itself, and one grouping by an open axis must not be handed a
// row per value that has none.
export function countScorecardGroups(
  records: readonly ScorecardRecord[],
  groupBy: ScorecardGroupBy,
): ScorecardGroupCount[] {
  const counts = new Map<string | null, number>();
  for (const record of records) {
    const key = scorecardGroupKey(record, groupBy);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count }));
}

// The append-only ledgers' optimistic guard (arch-review 7 P1, I5): `scoring` and `gates` are written as
// whole arrays, so two writers that both read [1] and write [1,2A] / [1,2B] silently LOSE an entry — a lost
// GateDecision is a governance-audit defect, a lost revision breaks scoring identity. A caller appending to
// either ledger states the length it read; the store commits ONLY if the persisted length still matches
// (WHERE jsonb_array_length guard on Pg, the same check in memory). A guard miss returns undefined exactly
// like a missing id — the caller just read the record, so undefined-under-guard IS the conflict signal
// (retry-reread for gates, refuse for a scoring settle). Append tables are the named longer-term shape.
// ── THE VOCABULARY THE TERMINAL VERB SPEAKS ─────────────────────────────────────────────────────────
//
// Five reviews found a settlement written through `update` with the fence forgotten, in a different place
// each time, and each fix was the same line added to one more caller. That is the shape of an API problem
// rather than a discipline problem: a condition every caller must remember is a condition some caller will
// not. `settleScorecard` / `settleRun` (`ports/settle.ts`) take the fence as a PARAMETER — there is nothing
// to leave out — and these are the two values they translate into a guard.
//
//   over: "open"     — the ordinary settle. Refuses a record that is already terminal (first terminal write
//                      wins), which is the rule every one of those callers meant.
//   over: "aborted"  — `settleAborted`'s shape. It attaches a cancelled or superseded batch's partials on
//                      purpose, and must never land on one that settled succeeded/failed — the domain's own
//                      rule, restated where the write happens because the domain guard runs in one process
//                      and the settle it races runs in another.
//
// `epoch` is the driver's fencing token, when the caller holds one (mig 0166). Absent = a record nobody has
// claimed, which is a single-replica install and not a weaker guarantee.
// The statuses an aborted settle may land on — the domain's rule ("legal over superseded/cancelled, never
// over succeeded/failed") as a value both stores condition on.
export const ABORTABLE_SETTLE_STATUSES = ["queued", "running", "cancelled", "superseded"] as const;

export interface SettleOptions {
  over: "open" | "aborted";
  epoch?: number;
  // The receipt count the settle read (see ScorecardUpdateGuard.expectReceiptCount).
  expectReceiptCount?: number;
  // The abort settle also OWNS its teardown, durably (arch-review 51 P0). See
  // ScorecardUpdateGuard.requestCancellation.
  requestCancellation?: true;
  // …and a SUCCESS settle owns its publication, by the same rule (arch-review 53, Wave C). See
  // ScorecardUpdateGuard.publishOperation.
  publishOperation?: PublicationOperation;
}

export interface ScorecardUpdateGuard {
  // ── THE CURRENT EXPORT RECEIPT MOVES FORWARD ONLY (arch-review 56, Wave F) ────────────────────────
  //
  // `ScorecardRecord.export` is the reader-facing projection of the publication ledger, and it was kept
  // monotonic by READING the ledger's position and then writing unconditionally. Nothing holds between those
  // two statements, and two publishers running at once is the ordinary shape of this seam — the winner drains
  // inline while the reconciler sweeps whatever a crash left owed. So revision 1 could read "behind", revision
  // 2 could complete and write, and revision 1 could then land on top of it. The ledger stayed right; the
  // answer a human reads went backwards.
  //
  // The condition therefore rides the WRITE: the update applies only while the receipt currently stored
  // belongs to a settlement OLDER than this one. A loser matches no row instead of matching the row it should
  // not have — the same shape as every other fence in this file, applied to the projection they all feed.
  expectExportRevisionBelow?: number;
  // FIRST TERMINAL WRITE WINS, FOR THE PARENT TOO (arch-review 29 P0). The run lifecycle got this fence one
  // review at a time; the aggregate that owns those runs never did — so a booting replica whose `resume`
  // read a batch that had SUCCEEDED in the meantime went on to tombstone it FAILED{INTERRUPTED}. That is not
  // a lost race, it is a successful evaluation recorded in history as an infrastructure failure.
  //
  // An exclusive owner claim does not cover it: `expectOwnerReplica` asks "is the dead replica still the
  // owner", which stays true after the work finished. Exclusive recovery claim is not a terminal-state claim.
  expectNonTerminal?: true;
  // …and the narrower form some transitions need. `settleAborted` deliberately writes OVER an aborted
  // terminal record — it attaches the partials a cancelled or superseded batch produced while keeping that
  // status — and its real rule is "never over succeeded/failed". A blanket non-terminal condition would
  // refuse the legitimate write; this states the domain's own rule at the storage boundary instead.
  expectStatusIn?: readonly string[];
  // THE RECOVERY CLAIM (arch-review 28 P1). Two control planes booting together both see a batch whose owner
  // stopped heartbeating, both stamp themselves as the new owner, and both resume it — the child terminal CAS
  // stops the ROWS from being corrupted and does nothing about two replicas dispatching the same unfinished
  // cases. Ownership and the authority to drive the work have to be one transition, not two.
  //
  //   a string — "the owner must still be this one" (the dead replica the recovery observed)
  //   null     — "there must be no owner recorded"
  //
  // A miss returns undefined like any other guard, and the loser must NOT resume: it did not claim the work.
  expectOwnerReplica?: string | null;
  // THE FENCING TOKEN (mig 0166). Owner identity elects a driver; it does not fence the previous one — a
  // replica that paused past the liveness threshold comes back with its execution loop still running, and
  // the database saying somebody else owns the batch does not reach it. Every write that DRIVES a batch
  // carries the epoch it won, so the stale driver's next write fails against a number that moved under it.
  expectOwnerEpoch?: number;
  // …and the ONE WRITE INSTRUCTION among the conditions, here for the reason `leaseSeconds` is: only the
  // store can raise the epoch atomically with the claim that wins it. Claiming and being told which takeover
  // you are cannot be two statements — that gap is the race this token exists to close.
  claimOwnership?: true;
  expectScoringCount?: number;
  expectGatesCount?: number;
  // THE PUBLICATION'S OWN FENCE (arch-review 52, Wave 4). The drain writes the receipt and flips the plan to
  // `published` in one update, conditioned on the plan still being the one it read — so two publishers (a
  // driver's inline drain and the reconciler, or two replicas that both believe they lead) produce exactly
  // ONE receipt. It is the same shape as every other guard here: a miss returns undefined, and the loser
  // must not treat its own drain as the published one.
  expectPublicationState?: "pending";
  // The decision context's freshness CAS (review 40): the receipt count the settle READ. Receipts are
  // insert-only, so equality proves the ledger did not move between the read and this terminal write — the
  // recorded read-set can never describe a ledger the summary was not computed over.
  expectReceiptCount?: number;
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
  // ── THE TEARDOWN IS OWED BY THE SAME TRANSACTION THAT DECIDES IT (arch-review 51 P0) ──────────────
  //
  // A WRITE INSTRUCTION like `claimOwnership`, here because only the store can make the pair atomic: the
  // cancellation-operation row used to be requested AFTER the terminal settle, best-effort — so a crash
  // between the CANCELLED/SUPERSEDED commit and the request left a decided abort whose teardown had no
  // durable owner, and the reconciler (which sweeps operation rows, not scorecards) could never find it.
  // Supersede had no user-facing retry at all, so its window was a permanent leak of live compute.
  //
  // With this set, the store upserts the operation row (state `requested`) in the SAME transaction as the
  // settle — the decision cannot commit without its teardown being owed. Applied only when the settle
  // matched a row, exactly like the outbox events. The in-memory store applies it through the attached
  // cancellation pair (no transaction to share — the documented dev-store degradation, same as E0).
  requestCancellation?: true;
  // THE SETTLEMENT'S OWED PUBLICATION, WRITTEN WITH THE SETTLE (arch-review 53, Wave C). The operation row
  // is inserted in this update's own statement, so a settle that lost its CAS leaves no debt behind and a
  // publisher has nothing to drain for it. Insert-only and idempotent on the operation id — a new settlement
  // ADDS a row, which is the whole difference from the singleton field it replaces (a re-score used to
  // overwrite the previous settlement's debt, and a stale publisher used to complete a newer one's).
  publishOperation?: PublicationOperation;
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
  // How many batches fall in each bucket of `groupBy`, under the SAME filter `list` takes — minus the paging
  // fields, which describe a page rather than the set. A paged screen cannot count what it does not hold, and
  // counting the rows it received reports the page size back to itself; this is where the true number comes
  // from. Buckets with zero rows are absent (a GROUP BY produces no row for them) — the caller stands the
  // empty columns of a CLOSED vocabulary itself, and must not stand one per absent value of an open axis.
  countByGroup(
    tenant: string | undefined,
    groupBy: ScorecardGroupBy,
    filter?: ScorecardListFilter,
  ): Promise<ScorecardGroupCount[]>;
  // Hard delete (scorecards are result records, not versioned reproducibility artifacts — no tombstone).
  // Returns false when the id doesn't exist. Tenant scoping is the service's job (get-then-check, like cancel).
  delete(id: string): Promise<boolean>;
}
