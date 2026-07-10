import type { ScorecardRecord, ScorecardStatus } from "@everdict/contracts";

// 레코드 스키마의 실체는 contracts/records — re-architecture P0c, db 는 compat 재수출.
export {
  type MetricSummary,
  MetricSummarySchema,
  type ScorecardExport,
  ScorecardExportSchema,
  type ScorecardModels,
  ScorecardModelsSchema,
  type ScorecardOrigin,
  ScorecardOriginSchema,
  type ScorecardRecord,
  ScorecardRecordSchema,
  ScorecardRunErrorSchema,
  type ScorecardStatus,
  ScorecardStatusSchema,
  type ScorecardStep,
  ScorecardStepSchema,
  type ScorecardSubset,
  ScorecardSubsetSchema,
  type ScorecardTrialSummary,
  ScorecardTrialSummarySchema,
} from "@everdict/contracts";

// list filter — narrows dataset/harness/status in the store (SQL) so leaderboard/trend don't scan the whole workspace.
// If unset, everything (current behavior). Summary-derived axes like model/judgeModel are still filtered in the service/suite (can't narrow in SQL).
export interface ScorecardListFilter {
  dataset?: string; // dataset.id
  harness?: string; // harness.id
  status?: ScorecardStatus;
}

// Scorecard store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
// Note: list intentionally omits the heavy `scorecard` (trace-included) field (summary only). Get the full thing via get.
export interface ScorecardStore {
  create(record: ScorecardRecord): Promise<void>;
  update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined>;
  get(id: string): Promise<ScorecardRecord | undefined>;
  list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]>;
}

export class InMemoryScorecardStore implements ScorecardStore {
  private readonly cards = new Map<string, ScorecardRecord>();

  async create(record: ScorecardRecord): Promise<void> {
    this.cards.set(record.id, record);
  }

  async update(id: string, patch: Partial<ScorecardRecord>): Promise<ScorecardRecord | undefined> {
    const cur = this.cards.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.cards.set(id, next);
    return next;
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.cards.get(id);
  }

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    const all = [...this.cards.values()]
      .filter((c) => !tenant || c.tenant === tenant)
      .filter((c) => !filter?.dataset || c.dataset.id === filter.dataset)
      .filter((c) => !filter?.harness || c.harness.id === filter.harness)
      .filter((c) => !filter?.status || c.status === filter.status);
    // List omits the heavy scorecard/steps + detail-only runIds/export (summary/models only) — get the detail via get.
    return all.map(({ scorecard, steps, runIds, export: _export, ...rest }) => rest);
  }
}
