import { z } from "zod";

// Scheduled (cron) scorecard — a stored RunScorecardInput + cron expression + policy. Firing reuses ScorecardService.submit.
// This (mutable) store is the SSOT (the UI/API truth); the Temporal Schedule is the execution mechanism (slice 2). Workspace-scoped.
// Design: docs/architecture/scheduled-evals.md.
export const ScheduleOverlapPolicySchema = z.enum(["skip", "bufferOne", "allowAll"]);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

// The eval definition that flows into ScorecardService.submit on firing (tenant/submittedBy are filled from the schedule at fire time).
export const ScheduleRunTemplateSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
export type ScheduleRunTemplate = z.infer<typeof ScheduleRunTemplateSchema>;

export const ScheduleRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(), // 5-field cron (validated at the boundary). Converted with timezone into a Temporal spec (slice 2).
  timezone: z.string(), // IANA tz (e.g. "Asia/Seoul"). Default "UTC".
  overlapPolicy: ScheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(), // creator subject — the fired run's submittedBy (budget → tenant, resolves private-repo connections).
  runTemplate: ScheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(), // the previous fire's result (scorecard status or error reason)
  lastScorecardId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

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
