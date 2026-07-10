import type { RunRecord } from "@everdict/contracts";
import { usageFromTrace } from "@everdict/domain";

// Record schemas now live in contracts/records — re-architecture P0c; db keeps compat re-exports (removed in the P4 sweep).
export {
  RunErrorSchema,
  type RunRecord,
  RunRecordSchema,
  type RunStatus,
  RunStatusSchema,
} from "@everdict/contracts";

// On read, fills the usage summary from result.trace (no stored column → always matches the trace, no migration needed).
export function withRunUsage(r: RunRecord): RunRecord {
  return r.result ? { ...r, usage: usageFromTrace(r.result.trace) } : r;
}

// The store port + its list options now live in @everdict/application-control — re-architecture P2c compat re-export (removed in the P4 sweep).
export type { RunListOptions, RunStore } from "@everdict/application-control";
import type { RunListOptions, RunStore } from "@everdict/application-control";

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
    // scorecardId given → that batch's children only; otherwise standalone (parentless) runs only (children hidden).
    const filtered = opts?.scorecardId
      ? scoped.filter((r) => r.parentScorecardId === opts.scorecardId)
      : scoped.filter((r) => r.parentScorecardId == null);
    return filtered.map(withRunUsage);
  }
}
