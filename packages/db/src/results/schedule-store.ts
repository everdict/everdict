import type { ScheduleRecord } from "@everdict/contracts";

// Record schemas now live in contracts/records — re-architecture P0c; db keeps compat re-exports (removed in the P4 sweep).
export {
  type ScheduleOverlapPolicy,
  ScheduleOverlapPolicySchema,
  type ScheduleRecord,
  ScheduleRecordSchema,
  type ScheduleRunTemplate,
  ScheduleRunTemplateSchema,
} from "@everdict/contracts";

// Schedule store contract — workspace (tenant) scoped. Swap in-memory (dev/test) or Postgres (production).
export interface ScheduleStore {
  create(record: ScheduleRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ScheduleRecord | undefined>;
  list(tenant: string): Promise<ScheduleRecord[]>;
  update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly byId = new Map<string, ScheduleRecord>();

  async create(record: ScheduleRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<ScheduleRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // treat another workspace's as nonexistent (no existence leak)
  }

  async list(tenant: string): Promise<ScheduleRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  }

  async update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined> {
    const cur = this.byId.get(id);
    if (!cur || cur.tenant !== tenant) return undefined;
    const next = { ...cur, ...patch, id: cur.id, tenant: cur.tenant }; // id/tenant are immutable
    this.byId.set(id, next);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const cur = this.byId.get(id);
    if (cur && cur.tenant === tenant) this.byId.delete(id);
  }
}
