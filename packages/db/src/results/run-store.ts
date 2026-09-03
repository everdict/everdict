import { CANCELLED_ERROR_CODE, type RunRecord } from "@everdict/contracts";
import { canReadRun, isRunTerminal, usageFromTrace } from "@everdict/domain";

// On read, fills the DERIVED usage from the run's result trace (no stored column → it always matches the
// result, and needs no migration). The VERDICT is deliberately NOT derived here: which policy judged a
// record is a domain interpretation the store cannot know — a scorecard child is judged under its parent's
// stamped/composed policy, and deriving under the default ladder in a persistence adapter made the run
// detail disagree with the scorecard case dialog about the same evidence. RunService.withVerdicts is the
// one owner of that derivation.
export function withRunUsage(r: RunRecord): RunRecord {
  if (!r.result) return r;
  return { ...r, usage: usageFromTrace(r.result.trace) };
}

import type {
  AttemptStamp,
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  PlatformEventStore,
  RunChildStatusCount,
  RunCreateGuard,
  RunListOptions,
  RunStore,
  RunUpdateGuard,
} from "@everdict/application-control";
import { ConflictError, TERMINAL_SCORECARD_STATUSES } from "@everdict/contracts";

// Apply offset/limit to an already-sorted (newest-first) slice — mirrors the Pg `OFFSET $6 LIMIT $5`.
// offset unset/0 = from the newest; limit unset = to the end.
function page(rows: RunRecord[], opts?: RunListOptions): RunRecord[] {
  const offset = opts?.offset ?? 0;
  return rows.slice(offset, opts?.limit !== undefined ? offset + opts.limit : undefined);
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  // Optional E0 outbox pair: facts append right after the write. Same-process, so "atomic enough" for the
  // dev/test store — the transactional guarantee is the Pg store's (one data-modifying-CTE statement).
  // `scoringPassOwner` resolves a scorecard's CURRENT pass owner, which is what the scoring fence compares
  // against. The Pg store reads it with a sub-select in the same statement; in memory the pair is wired at
  // composition (and left unset in tests that never fence), so the same guard exists on both stores rather
  // than being a production-only behavior the dev path silently lacks.
  constructor(private readonly events?: PlatformEventStore) {}

  // The cancellation pair (arch-review 52, Wave 3): Postgres upserts the operation row in the settle's own
  // statement; in memory the stores are separate objects, so the pairing is explicit (the same attach idiom
  // `InMemoryScorecardStore` uses for the batch lane's identical write). Applied right after a matched
  // write — the dev-store degradation of "same tx".
  private requestCancellationOf?: (runId: string) => void;
  attachCancellations(request: (runId: string) => void): void {
    this.requestCancellationOf = request;
  }

  // Pair this store with the scorecard store so the scoring FENCE can be evaluated (the same
  // `attachIssues` idiom the issue/label pair uses). Postgres answers the fence with a sub-select inside
  // the write statement; in memory the two stores are separate objects, so the pairing is explicit.
  // UNPAIRED, a fenced write is ALLOWED — and that is a documented property of the dev store, not a hole in
  // the invariant: an unpaired run store is not part of a scoring topology at all, and refusing instead
  // would break every unrelated test into attaching a stub that always says yes, which is a fence that
  // certifies nothing. The boundary this invariant protects is the Postgres one.
  attachScorecards(owner: {
    peek(
      id: string,
    ): { scoringPass?: { passId?: string; status?: string } | null; ownerEpoch?: number; status?: string } | undefined;
  }): void {
    // A TERMINAL pass is not an owner (arch-review 17 P0-3) — the Pg fence adds `status = 'running'` to the
    // same EXISTS, so the twin resolves an owner only while the marker is live. Answering the passId of a
    // failed marker here would let the in-memory pair accept a write the database refuses.
    this.scoringPassOwner = (scorecardId) => {
      const live = owner.peek(scorecardId)?.scoringPass;
      return live?.status === "running" ? live.passId : undefined;
    };
    // …and the parent's fencing token, which the child's own epoch cannot stand in for.
    this.parentDriverEpoch = (scorecardId) => owner.peek(scorecardId)?.ownerEpoch ?? 0;
    // …and whether that parent still ADMITS work: a cancel settles it terminal without touching the epoch,
    // so an epoch-only condition would let a proved loop open a case for a batch the user stopped.
    this.parentStatus = (scorecardId) => owner.peek(scorecardId)?.status;
  }

  // The dispatch intent's whole question: mine, and still open.
  private parentAdmitsWork(parent: { scorecardId: string; epoch: number }): boolean {
    if (this.parentDriverEpoch?.(parent.scorecardId) !== parent.epoch) return false;
    const status = this.parentStatus?.(parent.scorecardId);
    return status === undefined || !TERMINAL_SCORECARD_STATUSES.includes(status as never);
  }

  private scoringPassOwner?: (scorecardId: string) => string | undefined;
  private parentDriverEpoch?: (scorecardId: string) => number | undefined;
  private parentStatus?: (scorecardId: string) => string | undefined;

  async create(record: RunRecord, events?: OutboxEvent[], guard?: RunCreateGuard): Promise<void> {
    // The dispatch intent's condition, on the same terms as the update fence: with the scorecard pair wired,
    // a parent epoch that moved refuses the insert; unpaired, this store is not part of a batch topology.
    const parent = guard?.parentDriver;
    if (this.parentDriverEpoch && parent && !this.parentAdmitsWork(parent))
      throw new ConflictError(
        "CONFLICT",
        { scorecard: parent.scorecardId, run: record.id },
        "this replica no longer drives the batch — the case was not committed to",
      );
    this.runs.set(record.id, record);
    await this.appendEvents(events);
  }

  async update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    guard?: RunUpdateGuard,
  ): Promise<RunRecord | undefined> {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
    // Superseded writer → refused, exactly as the Pg cross-row condition refuses it. Without an owner
    // resolver the fence cannot be evaluated, and a fence that cannot be evaluated must REFUSE: silently
    // allowing the write would make the dev store the one place the invariant does not hold.
    const fence = guard?.scoring;
    if (this.scoringPassOwner && fence && this.scoringPassOwner(fence.scorecardId) !== fence.passId) return undefined;
    // …and the parent batch's driver fence (arch-review 33 P0), on the same terms as the scoring one: with
    // the pair wired, an epoch that moved under the writer refuses the write; unpaired, this store is not
    // part of a batch topology and the condition has nothing to evaluate.
    const parent = guard?.parentDriver;
    if (this.parentDriverEpoch && parent && this.parentDriverEpoch(parent.scorecardId) !== parent.epoch)
      return undefined;
    // …and the settled row refuses a second outcome, exactly as the SQL condition refuses it. A dev store that
    // allowed the overwrite would make the in-memory path the one place "first terminal write wins" is false.
    if (guard?.expectNonTerminal === true && isRunTerminal(cur)) return undefined;
    if (guard?.expectNotCancelled === true && cur.error?.code === CANCELLED_ERROR_CODE) return undefined;
    if (guard?.expectNoResult === true && cur.result !== undefined) return undefined;
    if (guard?.expectOwnerReplica !== undefined && (cur.ownerReplica ?? null) !== guard.expectOwnerReplica)
      return undefined;
    // The driver's fencing token (mig 0170) — a displaced loop's write fails against a number that moved.
    if (guard?.expectOwnerEpoch !== undefined && (cur.ownerEpoch ?? 0) !== guard.expectOwnerEpoch) return undefined;
    const next = {
      ...cur,
      ...patch,
      ...(guard?.claimOwnership === true ? { ownerEpoch: (cur.ownerEpoch ?? 0) + 1 } : {}),
      id: cur.id,
    };
    this.runs.set(id, next);
    // AFTER the guards, like the Pg CTE's `WHERE EXISTS (SELECT 1 FROM upd)`: a settle that lost the
    // terminal race decided nothing, so it owes no teardown.
    if (guard?.requestCancellation === true) this.requestCancellationOf?.(id);
    await this.appendEvents(events);
    return withRunUsage(next);
  }

  // The standalone lane's commit point (arch-review 45), sequentially. What this twin CAN give is the
  // ordering and the refusal — the stamp runs only after a settlement that committed, and a refused fence
  // runs no stamp at all. What it cannot give is ROLLBACK: a stamp that throws leaves the terminal write
  // already written (the same limitation `InMemoryCaseReceiptStore.commitCase` documents for its receipt).
  // The Pg twin is where the promotion is atomic; this one keeps the contract's observable shape so a
  // dev-store test cannot certify something production does not do.
  async settleWith(
    id: string,
    patch: Partial<RunRecord>,
    events: OutboxEvent[] | undefined,
    guard: RunUpdateGuard,
    stamp: AttemptStamp,
  ): Promise<RunRecord | undefined> {
    // ── THE STAMP GOES FIRST (arch-review 63 P1-high) ────────────────────────────────────────────────
    //
    // `committed` asks whether the parent may still be claimed, and the terminal write below is the thing
    // that closes it. Settling first made the guard refuse its own settlement, every time — being atomic is
    // not the same as being ordered. Handed the caller's own ledger, since there is no transaction to bind a
    // twin to.
    await stamp.apply(stamp.attempts);
    const settled = await this.update(id, patch, events, guard);
    if (settled === undefined) {
      // …and the stamp is TAKEN BACK when the fence refuses. A refusal means somebody else settled this run,
      // so this attempt did not produce the answer. The Pg twin gets this from ROLLBACK; here it is an
      // explicit compensation, and it is best-effort for the same reason the rest of this store is a dev
      // store: what it must not do is leave a `committed` row behind a settlement that never happened.
      await stamp.attempts.transition(stamp.attemptId, "superseded").catch(() => undefined);
      return undefined;
    }
    return settled;
  }

  private async appendEvents(events?: OutboxEvent[]): Promise<void> {
    if (!this.events || !events) return;
    for (const e of events) await this.events.append(e);
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const r = this.runs.get(id);
    return r ? withRunUsage(r) : undefined;
  }

  async list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    const inTenant = tenant ? all.filter((r) => r.tenant === tenant) : all;
    // The audience rule straight from the domain (the Pg twin restates it in SQL — the store tests pin the two
    // together). Applied BEFORE paging, like the query does.
    const viewer = opts?.viewer;
    const audience = viewer === undefined ? inTenant : inTenant.filter((r) => canReadRun(r, viewer));
    // A private team's runs are that team's work — the same ceiling every other team-owned read stays under.
    const teamScoped = audience;
    // …and the lifecycle narrowing the adapter applies in its WHERE (perf review). Before the page, like
    // every other predicate here: a twin that filtered after paging would answer a different size.
    const statuses = opts?.statuses;
    const scoped = statuses === undefined ? teamScoped : teamScoped.filter((r) => statuses.includes(r.status));
    // runnerId → runs this self-hosted runner executed (provenance), newest first, capped. Implies children included
    // (a runner mostly runs scorecard cases). Mirrors the Pg jsonb filter.
    if (opts?.runnerId) {
      const byRunner = scoped
        .filter((r) => r.result?.provenance?.runner === opts.runnerId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first (ISO strings sort lexicographically)
      return page(byRunner, opts).map(withRunUsage);
    }
    // scorecardId given → that batch's children only; includeChildren → all runs (standalone + children);
    // otherwise standalone (parentless) runs only (children hidden → prevents activity-list flooding).
    const filtered = opts?.scorecardId
      ? scoped.filter((r) => r.parentScorecardId === opts.scorecardId)
      : opts?.includeChildren
        ? scoped
        : scoped.filter((r) => r.parentScorecardId == null);
    return page(filtered, opts).map(withRunUsage);
  }

  // The twin of the grouped adapter read — same tenant scope, same "no children ⇒ no row" shape.
  async countChildrenByStatus(tenant: string, scorecardIds: readonly string[]): Promise<RunChildStatusCount[]> {
    if (scorecardIds.length === 0) return [];
    const wanted = new Set(scorecardIds);
    const counts = new Map<string, RunChildStatusCount>();
    for (const run of this.runs.values()) {
      if (run.tenant !== tenant) continue;
      const parent = run.parentScorecardId;
      if (parent === undefined || parent === null || !wanted.has(parent)) continue;
      const key = `${parent}\u0001${run.status}`;
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { scorecardId: parent, status: run.status, count: 1 });
    }
    return [...counts.values()];
  }

  async deleteByScorecard(scorecardId: string): Promise<number> {
    let removed = 0;
    for (const [id, r] of this.runs) {
      if (r.parentScorecardId === scorecardId && this.runs.delete(id)) removed++;
    }
    return removed;
  }

  async countActiveByEnvelope(tenant: string, envelopeId: string): Promise<number> {
    let active = 0;
    for (const r of this.runs.values()) {
      if (r.tenant !== tenant || r.envelope?.id !== envelopeId) continue;
      if (r.status === "queued" || r.status === "running") active++;
    }
    return active;
  }

  // The scheduler's fleet-wide tenant count (AdmissionLedger). Single-process by construction here — the
  // in-memory store IS one replica — so this answers exactly what the scheduler's own maps hold; the Pg twin is
  // where the cross-replica truth lives. The predicate is pinned to the port's contract and to the Pg twin.
  async inFlightByTenant(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const r of this.runs.values()) {
      if (r.status !== "running") continue;
      if (r.kind !== undefined && r.kind !== "eval") continue;
      if (r.lifetime === "session") continue;
      counts[r.tenant] = (counts[r.tenant] ?? 0) + 1;
    }
    return counts;
  }

  // HARD quota admission (AdmissionLedger.tryAdmit) — single-process, so the synchronous check-and-claim IS
  // the atomicity the Pg twin buys with its counter-row update re-check. Same permit vocabulary either way.
  private readonly admissionPermits = new Map<string, string>(); // permitId → tenant

  async tryAdmit(tenant: string, permitId: string, quota: number): Promise<boolean> {
    // A retry of an already-held permit is the SAME right (the Pg twin's `existing` arm) — answering false
    // here would refuse an at-quota entry its own permit.
    if (this.admissionPermits.has(permitId)) return true;
    let held = 0;
    for (const t of this.admissionPermits.values()) if (t === tenant) held++;
    if (held >= quota) return false;
    this.admissionPermits.set(permitId, tenant);
    return true;
  }

  async releaseAdmission(permitId: string): Promise<void> {
    this.admissionPermits.delete(permitId);
  }

  // No wall clock in the twin: a single process's permits die with it, so there is nothing to lease-reap and
  // renewal is a no-op. The lease semantics are certified against the Pg impl (fleet-admission trust suite).
  async renewAdmissions(_permitIds: string[]): Promise<void> {}

  async liveSessions(query: LiveSessionQuery = {}): Promise<LiveSessionRow[]> {
    const rows: LiveSessionRow[] = [];
    for (const r of this.runs.values()) {
      if (r.lifetime !== "session") continue;
      if (r.status !== "queued" && r.status !== "running") continue;
      if (query.tenant !== undefined && r.tenant !== query.tenant) continue;
      if (query.trigger !== undefined && r.trigger !== query.trigger) continue;
      const expiresAt = r.session?.expiresAt;
      rows.push({
        id: r.id,
        tenant: r.tenant,
        ...(r.createdBy !== undefined ? { createdBy: r.createdBy } : {}),
        ...(r.session?.agent?.agentId !== undefined ? { agentId: r.session.agent.agentId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    }
    return rows;
  }
}
