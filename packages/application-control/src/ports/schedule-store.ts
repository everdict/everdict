import type { ScheduleRecord } from "@everdict/contracts";

// Schedule store contract — workspace (tenant) scoped. Swap in-memory (dev/test) or Postgres (production).
export interface ScheduleStore {
  create(record: ScheduleRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ScheduleRecord | undefined>;
  list(tenant: string): Promise<ScheduleRecord[]>;
  update(tenant: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
