import type { RunRecord } from "@everdict/contracts";
import { canReadRun, caseVerdict, ownedByVisibleTeam, usageFromTrace } from "@everdict/domain";

// On read, fills the DERIVED fields from the run's result — usage from the trace, the case verdict from the
// scores (no stored columns → they always match the result, and neither needs a migration). The verdict is
// served rather than recomputed per client: the scorecard's per-case verdict already works this way, and the
// authority ranking (ground truth > objective > judge) must have exactly one implementation.
export function withRunUsage(r: RunRecord): RunRecord {
  if (!r.result) return r;
  const verdict = caseVerdict(r.result);
  return {
    ...r,
    usage: usageFromTrace(r.result.trace),
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

import type {
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  PlatformEventStore,
  RunListOptions,
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
  constructor(private readonly events?: PlatformEventStore) {}

  async create(record: RunRecord, events?: OutboxEvent[]): Promise<void> {
    this.runs.set(record.id, record);
    await this.appendEvents(events);
  }

  async update(id: string, patch: Partial<RunRecord>, events?: OutboxEvent[]): Promise<RunRecord | undefined> {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
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
