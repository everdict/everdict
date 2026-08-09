import type { RunRecord } from "@everdict/contracts";
import { canReadRun, ownedByVisibleTeam, usageFromTrace } from "@everdict/domain";

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
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  PlatformEventStore,
  RunListOptions,
  RunScoringFence,
  RunStore,
} from "@everdict/application-control";

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

  // Pair this store with the scorecard store so the scoring FENCE can be evaluated (the same
  // `attachIssues` idiom the issue/label pair uses). Postgres answers the fence with a sub-select inside
  // the write statement; in memory the two stores are separate objects, so the pairing is explicit.
  // UNPAIRED, a fenced write is ALLOWED — and that is a documented property of the dev store, not a hole in
  // the invariant: an unpaired run store is not part of a scoring topology at all, and refusing instead
  // would break every unrelated test into attaching a stub that always says yes, which is a fence that
  // certifies nothing. The boundary this invariant protects is the Postgres one.
  attachScorecards(owner: { peek(id: string): { scoringPass?: { passId?: string } } | undefined }): void {
    this.scoringPassOwner = (scorecardId) => owner.peek(scorecardId)?.scoringPass?.passId;
  }

  private scoringPassOwner?: (scorecardId: string) => string | undefined;

  async create(record: RunRecord, events?: OutboxEvent[]): Promise<void> {
    this.runs.set(record.id, record);
    await this.appendEvents(events);
  }

  async update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    fence?: RunScoringFence,
  ): Promise<RunRecord | undefined> {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
    // Superseded writer → refused, exactly as the Pg cross-row condition refuses it. Without an owner
    // resolver the fence cannot be evaluated, and a fence that cannot be evaluated must REFUSE: silently
    // allowing the write would make the dev store the one place the invariant does not hold.
    if (this.scoringPassOwner && fence && this.scoringPassOwner(fence.scorecardId) !== fence.passId) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.runs.set(id, next);
    await this.appendEvents(events);
    return withRunUsage(next);
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
    const scoped = audience.filter((r) => ownedByVisibleTeam(r, opts?.visibleTeams));
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
