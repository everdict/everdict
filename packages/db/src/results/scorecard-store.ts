import { SCORING_PASS_STALE_MS } from "@everdict/contracts";
import type { PublicationOperation, ScorecardRecord } from "@everdict/contracts";
import { ScorecardBatch } from "@everdict/domain";

import {
  type OutboxEvent,
  type PlatformEventStore,
  type ScorecardGroupBy,
  type ScorecardGroupCount,
  type ScorecardListFilter,
  type ScorecardStore,
  type ScorecardUpdateGuard,
  countScorecardGroups,
} from "@everdict/application-control";

export class InMemoryScorecardStore implements ScorecardStore {
  private readonly cards = new Map<string, ScorecardRecord>();
  // The receipt-count pairing (review 40): Postgres answers `expectReceiptCount` with a sub-select in the
  // same statement; in memory the two stores are separate objects, so the pairing is explicit (the same
  // attach idiom the run store uses for the scoring fence). UNPAIRED, a guarded write is ALLOWED — an
  // unpaired store is not part of a receipt topology at all (the documented dev-store stance).
  private receiptCountOf?: (scorecardId: string) => number;
  attachReceipts(countOf: (scorecardId: string) => number): void {
    this.receiptCountOf = countOf;
  }

  // The cancellation pair (arch-review 51 P0): Postgres upserts the operation row in the settle's own
  // statement; in memory the stores are separate objects, so the pairing is explicit (same attach idiom as
  // the receipts fence). Applied right after a matched write — the dev-store degradation of "same tx".
  private requestCancellationOf?: (scorecardId: string) => void;
  attachCancellations(request: (scorecardId: string) => void): void {
    this.requestCancellationOf = request;
  }

  // The publication pair (arch-review 53, Wave C): Postgres inserts the operation row in the settle's own
  // statement; in memory the stores are separate objects, so the pairing is explicit — the same attach idiom
  // the receipts fence and the cancellation row use. Applied right after a matched write.
  private openPublicationOf?: (operation: PublicationOperation) => void;
  attachPublications(open: (operation: PublicationOperation) => void): void {
    this.openPublicationOf = open;
  }

  // E0 outbox pair: in-memory has no transaction to share, so "same tx" degrades to "append right after the
  // write" — the ordering guarantee tests rely on (same as InMemoryRunStore).
  constructor(private readonly events?: PlatformEventStore) {}

  async create(record: ScorecardRecord, events?: OutboxEvent[]): Promise<void> {
    this.cards.set(record.id, record);
    await this.appendEvents(events);
  }

  async update(
    id: string,
    patch: Partial<ScorecardRecord>,
    events?: OutboxEvent[],
    guard?: ScorecardUpdateGuard,
  ): Promise<ScorecardRecord | undefined> {
    const cur = this.cards.get(id);
    if (!cur) return undefined;
    // The append-only ledgers' optimistic guard (I5) — a miss answers undefined like a missing id; the
    // caller (which just read the record) treats it as the concurrent-writer conflict it is.
    if (
      guard?.expectReceiptCount !== undefined &&
      this.receiptCountOf &&
      this.receiptCountOf(id) !== guard.expectReceiptCount
    )
      return undefined;
    if (guard?.expectScoringCount !== undefined && (cur.scoring?.length ?? 0) !== guard.expectScoringCount)
      return undefined;
    if (guard?.expectGatesCount !== undefined && (cur.gates?.length ?? 0) !== guard.expectGatesCount) return undefined;
    // First terminal write wins for the aggregate too (arch-review 29 P0) — the dev store must not be the one
    // place a settled batch can be rewritten.
    if (guard?.expectNonTerminal === true && ScorecardBatch.from(cur).isTerminal()) return undefined;
    // The recovery claim (arch-review 28 P1): exactly one replica may take a dead one's work, and the loser
    // must not resume — which it can only know by this returning undefined.
    if (guard?.expectOwnerReplica !== undefined && (cur.ownerReplica ?? null) !== guard.expectOwnerReplica)
      return undefined;
    if (guard?.expectStatusIn !== undefined && !guard.expectStatusIn.includes(cur.status)) return undefined;
    // THE EXPORT PROJECTION MOVES FORWARD ONLY (arch-review 56, Wave F). A stored receipt with no revision is
    // older than every revision — that is what a pre-Wave-F receipt IS, not an unknown.
    if (
      guard?.expectExportRevisionBelow !== undefined &&
      (cur.export?.scoringRevision ?? 0) >= guard.expectExportRevisionBelow
    )
      return undefined;
    // The driver's fencing token (mig 0166) — a stale loop's write fails against a number that moved.
    if (guard?.expectOwnerEpoch !== undefined && (cur.ownerEpoch ?? 0) !== guard.expectOwnerEpoch) return undefined;
    // The pass-claim CAS — `null` means "I read no epoch" (absent marker, or a legacy one), so a rival that
    // already stamped one wins and this write is refused.
    // passId is the FENCE — never reused, so it cannot collide across passes the way an epoch can.
    if (guard?.expectScoringPassId !== undefined) {
      const owner = cur.scoringPass?.passId ?? null;
      if (owner !== guard.expectScoringPassId) return undefined;
      // …and a TERMINAL pass has no authority left (arch-review 17 P0-3) — identity answers "who is this",
      // status answers "does it still have the right". Mirrors the Pg condition, including the takeover
      // exception: `expectScoringPassReclaimable` is a caller explicitly claiming a dead marker.
      if (
        guard.expectScoringPassId !== null &&
        guard.expectScoringPassReclaimable !== true &&
        cur.scoringPass?.status !== "running"
      )
        return undefined;
    }
    // Reclaimability, mirroring the Pg condition. One process, one clock — nothing to arbitrate here.
    if (guard?.expectScoringPassReclaimable === true) {
      const live = cur.scoringPass;
      const reclaimable =
        !live ||
        live.status === "failed" ||
        (live.leaseUntil !== undefined
          ? Date.parse(live.leaseUntil) <= Date.now()
          : Date.now() - Date.parse(live.startedAt) >= SCORING_PASS_STALE_MS);
      if (!reclaimable) return undefined;
    }
    // The publication's fence (mig 0187) — the drain writes its receipt only while the plan it read is still
    // the pending one, so two publishers produce exactly one receipt.
    if (guard?.expectPublicationState !== undefined && cur.publication?.state !== guard.expectPublicationState)
      return undefined;
    if (guard?.expectScoringPassEpoch !== undefined) {
      const persisted = cur.scoringPass?.epoch ?? null;
      if (persisted !== guard.expectScoringPassEpoch) return undefined;
    }
    const next = {
      ...cur,
      ...patch,
      id: cur.id,
      // The claim raises the epoch in the same act that wins it (mig 0166).
      ...(guard?.claimOwnership === true ? { ownerEpoch: (cur.ownerEpoch ?? 0) + 1 } : {}),
    };
    // The store stamps the lease's end (see the port) — one process, one clock, so this is trivially the
    // same clock the reclaimability check above reads. It still lives HERE rather than at the call site,
    // because the invariant being kept is "the lease is authored by whoever judges it", and an in-memory
    // pair that let the caller author it would stop being a faithful stand-in for the Pg one.
    if (guard?.stampScoringLeaseSeconds !== undefined && next.scoringPass) {
      next.scoringPass = {
        ...next.scoringPass,
        leaseUntil: new Date(Date.now() + guard.stampScoringLeaseSeconds * 1000).toISOString(),
      };
    }
    this.cards.set(id, next);
    if (guard?.requestCancellation === true) this.requestCancellationOf?.(id);
    if (guard?.publishOperation !== undefined) this.openPublicationOf?.(guard.publishOperation);
    await this.appendEvents(events);
    return next;
  }

  private async appendEvents(events?: OutboxEvent[]): Promise<void> {
    if (!this.events || !events) return;
    for (const e of events) await this.events.append(e);
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.cards.get(id);
  }

  // Synchronous peek — the scoring FENCE needs the parent's marker at the moment of a child write, and the
  // Pg store answers that with a sub-select inside the write statement. Exposed so the in-memory pair can
  // give the same answer without turning every child write into an await on another store's async read.
  peek(id: string): ScorecardRecord | undefined {
    return this.cards.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.cards.delete(id);
  }

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    // The ORDER is part of the contract, not a convenience: the Postgres twin has always answered
    // `created_at DESC, id DESC`, a keyset cursor is defined against that ordering, and a twin that returned
    // insertion order would page correctly in production and nonsensically in every unit test.
    const matched = [...this.cards.values()].filter((c) => matchesScorecardFilter(c, tenant, filter)).sort(newestFirst);
    const before = filter?.before;
    const page = before === undefined ? matched : matched.filter((c) => isBefore(c, before));
    const bounded = filter?.limit === undefined ? page : page.slice(0, Math.max(0, filter.limit));
    // List omits the heavy scorecard/steps + detail-only runIds/export/analysisRef (summary/models only) — get the detail via get.
    return bounded.map(({ scorecard, steps, runIds, export: _export, analysisRef, ...rest }) => rest);
  }

  async countByGroup(
    tenant: string | undefined,
    groupBy: ScorecardGroupBy,
    filter?: ScorecardListFilter,
  ): Promise<ScorecardGroupCount[]> {
    // Counts describe the SET, so the page fields are deliberately not applied here — a count narrowed by the
    // cursor would report the page back to the caller, which is the number it already has.
    return countScorecardGroups(
      [...this.cards.values()].filter((c) => matchesScorecardFilter(c, tenant, filter)),
      groupBy,
    );
  }
}

// The ONE predicate `list` and `countByGroup` share. Written twice, the next facet would have been added to
// one of them and the page would have disagreed with its own header (protocol L3).
function matchesScorecardFilter(
  c: ScorecardRecord,
  tenant: string | undefined,
  filter: ScorecardListFilter | undefined,
): boolean {
  if (tenant !== undefined && c.tenant !== tenant) return false;
  if (filter === undefined) return true;
  if (filter.dataset !== undefined && c.dataset.id !== filter.dataset) return false;
  if (filter.harness !== undefined && c.harness.id !== filter.harness) return false;
  if (filter.status !== undefined && c.status !== filter.status) return false;
  // Ownership ceiling — another team's batch is not visible at all; an unowned one is the workspace's.
  if (filter.judge !== undefined && !(c.orchestration?.judges ?? []).some((j) => j.id === filter.judge)) return false;
  if (filter.scheduleId !== undefined && c.origin?.scheduleId !== filter.scheduleId) return false;
  if (filter.productId !== undefined && c.origin?.productId !== filter.productId) return false;
  if (filter.seriesKey !== undefined && c.origin?.seriesKey !== filter.seriesKey) return false;
  if (filter.causedByRunId !== undefined && c.origin?.causedByRunId !== filter.causedByRunId) return false;
  // The publication reconciler's sweep (mig 0187) — settlements whose outward effects are still owed.
  if (filter.publicationPending === true && c.publication?.state !== "pending") return false;
  // kind filter (P1): "scorecard" also matches every pre-field record (kind unset = scorecard).
  if (filter.kind !== undefined && (filter.kind === "experiment" ? c.kind !== "experiment" : c.kind === "experiment"))
    return false;
  if (filter.runtime !== undefined && c.runtime !== filter.runtime) return false;
  if (filter.createdBy !== undefined && c.createdBy !== filter.createdBy) return false;
  // The facet SETS. `?? ""` renders the unset bucket, which is a value people filter to — a query string has
  // no null, so the empty string is its name on both sides.
  if (filter.statuses !== undefined && !filter.statuses.includes(c.status)) return false;
  if (filter.datasets !== undefined && !filter.datasets.includes(c.dataset.id)) return false;
  if (filter.harnesses !== undefined && !filter.harnesses.includes(c.harness.id)) return false;
  if (filter.runtimes !== undefined && !filter.runtimes.includes(c.runtime ?? "")) return false;
  if (filter.creators !== undefined && !filter.creators.includes(c.createdBy ?? "")) return false;
  // The dashboard's half-open window (perf review) — the twin filters it here so a service that narrows the
  // READ behaves the same against either store.
  if (filter.createdSince !== undefined && c.createdAt < filter.createdSince) return false;
  if (filter.day !== undefined && c.createdAt.slice(0, 10) !== filter.day) return false;
  if (filter.search !== undefined && filter.search !== "" && !matchesSearch(c, filter.search)) return false;
  return true;
}

// What the list SEARCHES — the batch id and the two capability ids it names, case-insensitively. The same
// text the in-browser search swept while the whole collection was in hand.
function matchesSearch(c: ScorecardRecord, search: string): boolean {
  const needle = search.toLowerCase();
  return `${c.id} ${c.harness.id} ${c.dataset.id}`.toLowerCase().includes(needle);
}

// Newest first, the id breaking the tie so the ordering is TOTAL — a keyset cursor over a non-total order
// either repeats a row or skips one at every page boundary where two batches share a timestamp.
function newestFirst(a: ScorecardRecord, b: ScorecardRecord): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

// Strictly older than the cursor row IN THAT ordering (the row-value comparison the Pg twin writes as
// `(created_at, id) < ($ts, $id)`).
function isBefore(c: ScorecardRecord, cursor: { createdAt: string; id: string }): boolean {
  if (c.createdAt !== cursor.createdAt) return c.createdAt < cursor.createdAt;
  return c.id < cursor.id;
}
