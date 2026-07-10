import { type RunRecord, usageFromTrace } from "@everdict/contracts";

// 레코드 스키마의 실체는 contracts/records — re-architecture P0c, db 는 compat 재수출.
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

// list options. The default (unset) returns only standalone runs — hides scorecard child runs to prevent activity-list flooding.
// With scorecardId, returns only that batch's child runs (for the case drill-down in scorecard detail).
export interface RunListOptions {
  scorecardId?: string;
}

// Result store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
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
    // scorecardId given → that batch's children only; otherwise standalone (parentless) runs only (children hidden).
    const filtered = opts?.scorecardId
      ? scoped.filter((r) => r.parentScorecardId === opts.scorecardId)
      : scoped.filter((r) => r.parentScorecardId == null);
    return filtered.map(withRunUsage);
  }
}
