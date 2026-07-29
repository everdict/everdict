import type { ApprovalListFilter, ApprovalStore, OutboxEvent, PlatformEventStore } from "@everdict/application-control";
import type { ApprovalRecord } from "@everdict/contracts";

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, ApprovalRecord>();

  // E0 outbox pair: in-memory has no transaction, so "same tx" degrades to append-right-after-the-write
  // (same as InMemoryRunStore/InMemoryScorecardStore).
  constructor(private readonly events?: PlatformEventStore) {}

  async create(record: ApprovalRecord, events?: OutboxEvent[]): Promise<void> {
    this.rows.set(record.id, record);
    await this.appendEvents(events);
  }

  async update(
    id: string,
    patch: Partial<ApprovalRecord>,
    events?: OutboxEvent[],
  ): Promise<ApprovalRecord | undefined> {
    const cur = this.rows.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.rows.set(id, next);
    await this.appendEvents(events);
    return next;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.rows.get(id);
  }

  async list(tenant: string, filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenant === tenant)
      .filter((r) => !filter?.status || r.status === filter.status)
      .filter((r) => !filter?.sessionId || r.sessionId === filter.sessionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private async appendEvents(events?: OutboxEvent[]): Promise<void> {
    if (!this.events || !events) return;
    for (const e of events) await this.events.append(e);
  }
}
