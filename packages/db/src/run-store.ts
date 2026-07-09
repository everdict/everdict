import { CaseResultSchema, EvalCaseSchema, RunUsageSummarySchema, usageFromTrace } from "@everdict/core";
import { z } from "zod";

// A run's lifecycle: accept → (scheduler queue/dispatch) → success/failure. The result store keeps this record.
export const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorSchema = z.object({ code: z.string(), message: z.string() });

export const RunRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: RunStatusSchema,
  result: CaseResultSchema.optional(),
  // The submitted EvalCase (standalone runs, mig 0051) — boot recovery's re-dispatch basis. Absent on batch
  // children (the batch re-plans from its dataset) and on legacy records (those keep the tombstone path).
  caseSpec: EvalCaseSchema.optional(),
  // Usage summary — not stored, derived from result.trace (filled on read). Lets the client see tokens/cost without parsing the trace.
  usage: RunUsageSummarySchema.optional(),
  error: RunErrorSchema.optional(),
  // Which scorecard batch this run is a child of (if any). Filled by the scorecard as it fans out a child run per case.
  // Unset = standalone (one-off) run. The activity list hides children by default (prevents flooding) → see the list option.
  parentScorecardId: z.string().optional(),
  // Why this run was created (source). standalone|scorecard|schedule|mcp|front-door etc. — the activity-view source axis.
  // A dumb store, so the value itself isn't validated (free string). Unset = standalone.
  trigger: z.string().optional(),
  // Runner (submitter subject) — the notification-feed recipient (notifications N2) + shows "who". Machine-fired is unset. mig 0036.
  createdBy: z.string().optional(),
  // The runtime it was placed on (placement.target: registered runtime id | self:<runnerId>) — the work-queue's "where does it run" axis. mig 0040.
  // Unset = default backend. Past records are unset.
  runtime: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

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
