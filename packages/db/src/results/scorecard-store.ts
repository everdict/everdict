import type { ScorecardRecord } from "@everdict/contracts";

import type {
  OutboxEvent,
  PlatformEventStore,
  ScorecardListFilter,
  ScorecardStore,
} from "@everdict/application-control";

export class InMemoryScorecardStore implements ScorecardStore {
  private readonly cards = new Map<string, ScorecardRecord>();

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
  ): Promise<ScorecardRecord | undefined> {
    const cur = this.cards.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.cards.set(id, next);
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
      .filter((c) => !filter?.scheduleId || c.origin?.scheduleId === filter.scheduleId)
      .filter((c) => !filter?.causedByRunId || c.origin?.causedByRunId === filter.causedByRunId)
      // kind filter (P1): "scorecard" also matches every pre-field record (kind unset = scorecard).
      .filter(
        (c) => !filter?.kind || (filter.kind === "experiment" ? c.kind === "experiment" : c.kind !== "experiment"),
      );
    // List omits the heavy scorecard/steps + detail-only runIds/export/analysisRef (summary/models only) — get the detail via get.
    return all.map(({ scorecard, steps, runIds, export: _export, analysisRef, ...rest }) => rest);
  }
}
