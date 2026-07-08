import { BadRequestError, ForbiddenError, NotFoundError, classifyFailure } from "@everdict/core";
import type { ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunTemplate, ScheduleStore } from "@everdict/db";
import type { RunScorecardInput } from "./scorecard-service.js";

// Lightweight structural check of a 5-field cron — firing (Temporal Schedule, slice 2) parses precisely, so here we only reject obviously malformed input.
// Each field: * | n | n-m, optional step (/k), comma list. (Value-range semantics are enforced by Temporal.)
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

export interface CreateScheduleInput {
  tenant: string;
  createdBy: string; // submitter subject — the fired run's submittedBy (budget → tenant, private-repo connection resolve)
  name: string;
  cron: string;
  timezone?: string; // default "UTC"
  overlapPolicy?: ScheduleOverlapPolicy; // default "skip"
  enabled?: boolean; // default true
  runTemplate: ScheduleRunTemplate;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  timezone?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  enabled?: boolean; // pause/resume
  runTemplate?: ScheduleRunTemplate;
}

// Minimal spec handed to a Temporal Schedule (the driver converts cron→Schedule). The firing workflow's args are (tenant, id).
export interface ScheduleSpec {
  id: string;
  tenant: string;
  cron: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  paused: boolean; // = !enabled
}

// DB↔Temporal sync driver (implementation = @everdict/orchestrator TemporalScheduleDriver). Not injected = DB-only (no firing — dev/Direct).
export interface ScheduleDriver {
  ensure(spec: ScheduleSpec): Promise<void>; // create-or-update (idempotent), reflects paused
  remove(id: string): Promise<void>;
  // Optional: the next fire times computed by Temporal (authoritative). Query many ids over one connection → per-id ISO array.
  // If unimplemented (dev/Direct), the service skips enrichment and the web falls back to a cron approximation.
  describeMany?(ids: string[]): Promise<Record<string, string[]>>;
}

// Read response = stored record + (if a driver is present) the next fire times computed by Temporal. Not persisted — attached at read time.
export type ScheduleRecordWithNext = ScheduleRecord & { nextFireTimes?: string[] };

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  // Temporal sync — if not injected, schedules are only stored/managed and never fire (Temporal-less dev path).
  driver?: ScheduleDriver;
  // Called on fire (= ScorecardService.submit). If not injected, fire throws BadRequest (firing disabled).
  submitScorecard?: (input: RunScorecardInput) => Promise<{ id: string; status: string }>;
  // Polls the fired scorecard's status (workflow poll-to-terminal). If not injected, the status route is disabled.
  scorecardStatus?: (scorecardId: string) => Promise<string | undefined>;
  // For regression alerts: previous↔current scorecard diff (= ScorecardService.diff). Throws if either is incomplete/errored → finalize swallows it.
  diffScorecards?: (
    tenant: string,
    baselineId: string,
    candidateId: string,
  ) => Promise<{ regressions: RegressionDelta[] }>;
  // Alert when a regression is caught (= NotificationService.notifyRegression). If not injected, regression alerts are disabled (completion alerts come from the scorecard's onComplete).
  notifyRegression?: (tenant: string, payload: RegressionAlert) => Promise<void>;
  newId?: () => string;
  now?: () => string;
}

// One regression from a diff (case × metric) — only the fields the alert message needs.
export interface RegressionDelta {
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
}
export interface RegressionAlert {
  scheduleName: string;
  scorecardId: string;
  previousScorecardId: string;
  regressions: RegressionDelta[];
  createdBy?: string; // schedule creator — personal notification-feed recipient (notifications N2)
}

// Scheduled (cron) scorecard CRUD. Firing (Temporal Schedule sync + workflow) is slice 2 — here we manage only the SSOT record.
// Workspace (tenant) scoped; AppError is thrown as-is so the caller (server/MCP) maps it to a status code.
// Design: docs/architecture/scheduled-evals.md.
export class ScheduleService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private specOf(record: ScheduleRecord): ScheduleSpec {
    return {
      id: record.id,
      tenant: record.tenant,
      cron: record.cron,
      timezone: record.timezone,
      overlapPolicy: record.overlapPolicy,
      paused: !record.enabled, // a disabled schedule is paused in Temporal → does not fire
    };
  }

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    if (!isValidCron(input.cron))
      throw new BadRequestError(
        "BAD_REQUEST",
        { cron: input.cron },
        `cron expression is invalid (5 fields required): '${input.cron}'`,
      );
    const ts = this.now();
    const record: ScheduleRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      overlapPolicy: input.overlapPolicy ?? "skip",
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
      runTemplate: input.runTemplate,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    // Temporal sync — on failure, roll back the DB record to stay consistent (avoid a schedule that exists but never fires).
    if (this.deps.driver) {
      try {
        await this.deps.driver.ensure(this.specOf(record));
      } catch (err) {
        await this.deps.store.remove(record.tenant, record.id).catch(() => {});
        throw err;
      }
    }
    return record;
  }

  async list(tenant: string): Promise<ScheduleRecordWithNext[]> {
    return this.attachNextFires(await this.deps.store.list(tenant));
  }

  // Workspace-scoped single fetch (public — API/MCP). Missing or another workspace → 404 (no existence leak). Attaches the Temporal next fire times.
  async get(tenant: string, id: string): Promise<ScheduleRecordWithNext> {
    const record = await this.getRecord(tenant, id);
    const [enriched] = await this.attachNextFires([record]);
    return enriched ?? record;
  }

  // Internal single fetch (raw record — no Temporal describe). For update/remove/fire/finalize existence/ownership checks and field reads.
  private async getRecord(tenant: string, id: string): Promise<ScheduleRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' not found.`);
    return record;
  }

  // Attach Temporal-computed next fire times (nextFireTimes) to enabled schedules — only when a driver + describeMany are present.
  // Batch-queried over one connection. On failure/unimplemented, return as-is (the web falls back to a cron approximation). Paused schedules are excluded from the query (they don't fire).
  private async attachNextFires(records: ScheduleRecord[]): Promise<ScheduleRecordWithNext[]> {
    const driver = this.deps.driver;
    if (!driver?.describeMany) return records;
    const ids = records.filter((r) => r.enabled).map((r) => r.id);
    if (ids.length === 0) return records;
    const next = await driver.describeMany(ids).catch(() => ({}) as Record<string, string[]>);
    return records.map((r) => (next[r.id]?.length ? { ...r, nextFireTimes: next[r.id] } : r));
  }

  // Update — pause/resume (enabled) is member+, content edits (name/cron/timezone/overlap/runTemplate) are creator or admin only.
  // actor is injected by the call boundary (route/MCP); if not injected (internal call/test), the ownership check is skipped.
  async update(
    tenant: string,
    id: string,
    patch: UpdateScheduleInput,
    actor?: { subject: string; isAdmin: boolean },
  ): Promise<ScheduleRecord> {
    if (patch.cron !== undefined && !isValidCron(patch.cron))
      throw new BadRequestError(
        "BAD_REQUEST",
        { cron: patch.cron },
        `cron expression is invalid (5 fields required): '${patch.cron}'`,
      );
    const existing = await this.getRecord(tenant, id); // existence/ownership check (404)
    // A 'content edit' — changing any field other than enabled — is creator/admin only (because firing runs under the creator's identity). pause is member+.
    const editsContent = Object.keys(patch).some((k) => k !== "enabled");
    if (editsContent && actor && existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "schedules:edit" },
        "You do not have permission to edit this schedule (schedule creator or workspace admin only).",
      );
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `schedule '${id}' not found.`);
    await this.deps.driver?.ensure(this.specOf(updated)); // re-sync cron/timezone/overlap/pause
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.getRecord(tenant, id); // existence/ownership check (404)
    await this.deps.driver?.remove(id); // remove from Temporal first (stop firing) — if it fails, leave the DB untouched
    await this.deps.store.remove(tenant, id);
  }

  // When a creator (createdBy) leaves the workspace, bulk-disable the active schedules they created — the fired run runs
  // under the creator's identity (budget, private-repo connection), so it can no longer be trusted. Also pause in Temporal (driver.ensure). Called from the member-removal hook.
  // Returns = number of schedules disabled.
  async disableByCreator(tenant: string, createdBy: string): Promise<number> {
    const targets = (await this.deps.store.list(tenant)).filter((s) => s.createdBy === createdBy && s.enabled);
    for (const s of targets) {
      const updated = await this.deps.store.update(tenant, s.id, {
        enabled: false,
        lastStatus: "Auto-disabled: creator left the workspace",
        updatedAt: this.now(),
      });
      if (updated) await this.deps.driver?.ensure(this.specOf(updated)); // Temporal pause
    }
    return targets.length;
  }

  // Fire (called by the Temporal workflow via an internal route) — submit the schedule's runTemplate under the creator's identity.
  // Records lastFired/last* and also returns the previous schedule run id (the lastScorecardId just before this fire) for regression comparison.
  // If no firer is configured, BadRequest (Temporal-less dev).
  async fire(tenant: string, id: string): Promise<{ scorecardId: string; previousScorecardId?: string }> {
    const schedule = await this.getRecord(tenant, id); // 404
    if (!this.deps.submitScorecard)
      throw new BadRequestError("BAD_REQUEST", { id }, "Scorecard firer is not configured (firing disabled).");
    const previousScorecardId = schedule.lastScorecardId; // the run just before this fire (finalize's regression baseline)
    const t = schedule.runTemplate;
    let rec: Awaited<ReturnType<NonNullable<ScheduleServiceDeps["submitScorecard"]>>>;
    try {
      rec = await this.deps.submitScorecard({
        tenant,
        submittedBy: schedule.createdBy, // fired run = creator's identity (budget → tenant, private-repo connection resolve)
        origin: { source: "schedule" }, // provenance — stamp that this is a schedule fire
        dataset: t.dataset,
        harness: t.harness,
        judges: t.judges,
        ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
        ...(t.concurrency !== undefined ? { concurrency: t.concurrency } : {}),
      });
    } catch (err) {
      // A CONFIG-class submit failure is deterministic — the same fire fails the same way on every tick (deleted
      // dataset/harness, revoked credentials/authz, invalid template, exhausted budget). Firing on is pure noise:
      // AUTO-DISABLE with a visible reason (the same pattern as creator-left) and pause the Temporal schedule.
      // Transient failures rethrow — the workflow's activity retry owns those.
      const failure = classifyFailure(err, "dispatch");
      if (failure.class === "config") {
        const updated = await this.deps.store.update(tenant, id, {
          enabled: false,
          lastStatus: `Auto-disabled: ${failure.code} — ${failure.message}`.slice(0, 300),
          updatedAt: this.now(),
        });
        if (updated) await this.deps.driver?.ensure(this.specOf(updated)); // Temporal pause
      }
      throw err;
    }
    await this.deps.store.update(tenant, id, {
      lastFiredAt: this.now(),
      lastScorecardId: rec.id,
      lastStatus: rec.status,
      updatedAt: this.now(),
    });
    return { scorecardId: rec.id, ...(previousScorecardId !== undefined ? { previousScorecardId } : {}) };
  }

  // The fired scorecard's status (workflow poll-to-terminal). undefined if not configured.
  scorecardStatus(scorecardId: string): Promise<string | undefined> {
    return this.deps.scorecardStatus?.(scorecardId) ?? Promise.resolve(undefined);
  }

  // Finalize (called by the workflow after poll-to-terminal) — record the final status and, if there are regressions vs the previous run, alert.
  // diff requires both to be complete (throws if incomplete/errored) → swallow and skip only the regression alert (completion alerts come from the scorecard's onComplete).
  async finalize(tenant: string, id: string, scorecardId: string, previousScorecardId?: string): Promise<void> {
    const schedule = await this.getRecord(tenant, id); // 404 (if the schedule was deleted, nothing more to do)
    const status = await this.scorecardStatus(scorecardId);
    if (status !== undefined) await this.deps.store.update(tenant, id, { lastStatus: status, updatedAt: this.now() });
    if (!previousScorecardId || !this.deps.diffScorecards || !this.deps.notifyRegression) return;
    let regressions: RegressionDelta[];
    try {
      ({ regressions } = await this.deps.diffScorecards(tenant, previousScorecardId, scorecardId));
    } catch {
      return; // one side is incomplete/failed → cannot compare, skip the regression alert
    }
    if (regressions.length === 0) return;
    await this.deps.notifyRegression(tenant, {
      scheduleName: schedule.name,
      scorecardId,
      previousScorecardId,
      regressions,
      createdBy: schedule.createdBy, // schedule creator → personal notification-feed recipient (notifications N2)
    });
  }
}
