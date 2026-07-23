import type { ScorecardRecord } from "@everdict/contracts";

import type { ScorecardListFilter, ScorecardStore } from "@everdict/application-control";

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

  async delete(id: string): Promise<boolean> {
    return this.cards.delete(id);
  }

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    const all = [...this.cards.values()]
      .filter((c) => !tenant || c.tenant === tenant)
      .filter((c) => !filter?.dataset || c.dataset.id === filter.dataset)
      .filter((c) => !filter?.harness || c.harness.id === filter.harness)
      .filter((c) => !filter?.status || c.status === filter.status)
      .filter((c) => !filter?.judge || (c.orchestration?.judges ?? []).some((j) => j.id === filter.judge))
      .filter((c) => !filter?.scheduleId || c.origin?.scheduleId === filter.scheduleId);
    // List omits the heavy scorecard/steps + detail-only runIds/export (summary/models only) — get the detail via get.
    return all.map(({ scorecard, steps, runIds, export: _export, ...rest }) => rest);
  }
}
