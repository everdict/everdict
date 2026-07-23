import type { RunRecord } from "@everdict/contracts";
import { usageFromTrace } from "@everdict/domain";

// On read, fills the usage summary from result.trace (no stored column → always matches the trace, no migration needed).
export function withRunUsage(r: RunRecord): RunRecord {
  return r.result ? { ...r, usage: usageFromTrace(r.result.trace) } : r;
}

import type { RunListOptions, RunStore } from "@everdict/application-control";

// Apply offset/limit to an already-sorted (newest-first) slice — mirrors the Pg `OFFSET $6 LIMIT $5`.
// offset unset/0 = from the newest; limit unset = to the end.
function page(rows: RunRecord[], opts?: RunListOptions): RunRecord[] {
  const offset = opts?.offset ?? 0;
  return rows.slice(offset, opts?.limit !== undefined ? offset + opts.limit : undefined);
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async create(record: RunRecord): Promise<void> {
    this.runs.set(record.id, record);
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.runs.set(id, next);
    return withRunUsage(next);
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const r = this.runs.get(id);
    return r ? withRunUsage(r) : undefined;
  }

  async list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    const scoped = tenant ? all.filter((r) => r.tenant === tenant) : all;
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
}
