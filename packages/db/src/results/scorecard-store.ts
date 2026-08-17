import { SCORING_PASS_STALE_MS } from "@everdict/contracts";
import type { PublicationOperation, ScorecardRecord } from "@everdict/contracts";
import { ScorecardBatch } from "@everdict/domain";

import type {
  OutboxEvent,
  PlatformEventStore,
  ScorecardListFilter,
  ScorecardStore,
  ScorecardUpdateGuard,
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
    const all = [...this.cards.values()]
      .filter((c) => !tenant || c.tenant === tenant)
      .filter((c) => !filter?.dataset || c.dataset.id === filter.dataset)
      .filter((c) => !filter?.harness || c.harness.id === filter.harness)
      .filter((c) => !filter?.status || c.status === filter.status)
      .filter((c) => !filter?.teamId || c.teamId === filter.teamId)
      // Ownership ceiling — another team's batch is not visible at all; an unowned one is the workspace's.
      .filter((c) => !filter?.visibleTeams || c.teamId === undefined || filter.visibleTeams.includes(c.teamId))
      .filter((c) => !filter?.judge || (c.orchestration?.judges ?? []).some((j) => j.id === filter.judge))
      .filter((c) => !filter?.scheduleId || c.origin?.scheduleId === filter.scheduleId)
      .filter((c) => !filter?.productId || c.origin?.productId === filter.productId)
      .filter((c) => !filter?.seriesKey || c.origin?.seriesKey === filter.seriesKey)
      .filter((c) => !filter?.causedByRunId || c.origin?.causedByRunId === filter.causedByRunId)
      // The publication reconciler's sweep (mig 0187) — settlements whose outward effects are still owed.
      .filter((c) => filter?.publicationPending !== true || c.publication?.state === "pending")
      // kind filter (P1): "scorecard" also matches every pre-field record (kind unset = scorecard).
      .filter(
        (c) => !filter?.kind || (filter.kind === "experiment" ? c.kind === "experiment" : c.kind !== "experiment"),
      );
    // List omits the heavy scorecard/steps + detail-only runIds/export/analysisRef (summary/models only) — get the detail via get.
    return all.map(({ scorecard, steps, runIds, export: _export, analysisRef, ...rest }) => rest);
  }
}
