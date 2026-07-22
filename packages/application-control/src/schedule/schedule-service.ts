import {
  AppError,
  BadRequestError,
  NotFoundError,
  type ScheduleOverlapPolicy,
  type ScheduleRecord,
  type ScheduleRunTemplate,
} from "@everdict/contracts";
import { Schedule, type ScheduleSpec, classifyFailure } from "@everdict/domain";
import type { ScheduleStore } from "../ports/schedule-store.js";
import type { PullIngestInput } from "../scorecard/scorecard-shared.js";
import type { RunScorecardInput } from "../scorecard/scorecard-service.js";

// Cron validity and the Temporal spec shape are owned by the domain model (@everdict/domain) — re-exported here
// so existing importers (server.ts, route-context, request DTOs, the Temporal driver) keep their path.
export { isValidCron } from "@everdict/domain";
export type { ScheduleSpec } from "@everdict/domain";

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
  // Called on a BATCH-mode fire (= ScorecardService.submit). If not injected, a batch fire throws BadRequest (firing disabled).
  submitScorecard?: (input: RunScorecardInput) => Promise<{ id: string; status: string }>;
  // Called on a PULL-mode fire (= ScorecardService.ingestPull) — judge the recent traces of a rolling window (no harness
  // run). If not injected, a pull-mode fire throws BadRequest.
  ingestPull?: (input: PullIngestInput) => Promise<{ id: string; status: string }>;
  // Enumerate a registered trace source's trace ids within a time window (= TraceSourceService.listTraces → ids). The
  // pull fire uses it to turn the rolling window into the ingestPull runs mapping. If not injected, a pull fire throws.
  listTraceIds?: (
    tenant: string,
    source: string,
    opts: { scope?: string; since: string; until: string; limit?: number },
  ) => Promise<string[]>;
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
    return Schedule.from(record).toTemporalSpec();
  }

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    // The domain owns the creation shape (defaults UTC/skip/enabled) and the cron-validity 400.
    const record = Schedule.newRecord({ ...input, id: this.newId(), now: this.now() });
    await this.deps.store.create(record);
    // Temporal sync — on failure, roll back the DB record to stay consistent (avoid a schedule that exists but never fires).
    if (this.deps.driver) {
      try {
        await this.deps.driver.ensure(this.specOf(record));
      } catch (err) {
        // If the rollback itself also fails, the record is orphaned (stored in the DB but never fires) —
        // surface that on the rethrown ensure error instead of swallowing it; never mask the original failure.
        try {
          await this.deps.store.remove(record.tenant, record.id);
        } catch (rollbackErr) {
          throw markRollbackFailed(err, rollbackErr, record.id);
        }
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
    if (patch.cron !== undefined) Schedule.assertValidCron(patch.cron);
    const existing = await this.getRecord(tenant, id); // existence/ownership check (404)
    // Content edits (any field other than enabled) are creator/admin gated — the domain owns the rule.
    Schedule.from(existing).assertCanEdit(patch, actor);
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
    const targets = (await this.deps.store.list(tenant)).filter(
      (s) => s.createdBy === createdBy && Schedule.from(s).isEnabled(),
    );
    for (const s of targets) {
      const updated = await this.deps.store.update(
        tenant,
        s.id,
        Schedule.from(s).autoDisable("creator left the workspace", this.now()),
      );
      if (updated) await this.deps.driver?.ensure(this.specOf(updated)); // Temporal pause
    }
    return targets.length;
  }

  // Fire (called by the Temporal workflow via an internal route) — submit the schedule's runTemplate under the creator's identity.
  // Records lastFired/last* and also returns the previous schedule run id (the lastScorecardId just before this fire) for regression comparison.
  // If no firer is configured, BadRequest (Temporal-less dev).
  async fire(tenant: string, id: string): Promise<{ scorecardId: string; previousScorecardId?: string }> {
    const schedule = await this.getRecord(tenant, id); // 404
    const t = schedule.runTemplate;
    const { submitScorecard, ingestPull, listTraceIds } = this.deps;
    // Firer-configured checks live OUTSIDE the try: a missing firer is a deployment-config problem, not a schedule-config
    // one, so it must NOT auto-disable the schedule (the catch's classifyFailure would). Each mode needs its own firer.
    if (t.pull) {
      if (!ingestPull || !listTraceIds)
        throw new BadRequestError(
          "BAD_REQUEST",
          { id },
          "Trace-evaluation firer is not configured (pull firing disabled).",
        );
    } else if (!submitScorecard) {
      throw new BadRequestError("BAD_REQUEST", { id }, "Scorecard firer is not configured (firing disabled).");
    }
    const previousScorecardId = schedule.lastScorecardId; // the run just before this fire (finalize's regression baseline)
    let rec: { id: string; status: string };
    try {
      if (t.pull && ingestPull && listTraceIds) {
        // Trace-evaluation fire — enumerate the rolling window's traces and judge them (no harness run). An empty window
        // yields an empty (succeeded) scorecard, so a quiet day is recorded rather than erroring.
        const until = this.now();
        const since = new Date(Date.parse(until) - t.pull.windowHours * 3_600_000).toISOString();
        const traceIds = await listTraceIds(tenant, t.pull.source, {
          ...(t.pull.scope !== undefined ? { scope: t.pull.scope } : {}),
          since,
          until,
          limit: 500,
        });
        rec = await ingestPull({
          tenant,
          submittedBy: schedule.createdBy,
          origin: { source: "schedule" },
          // correlate:"id" — the ids ARE the platform's real trace ids (from listTraceIds), so fetch by id.
          source: { name: t.pull.source, correlate: t.pull.correlate ?? "id" },
          runs: traceIds.map((tid) => ({ caseId: tid, runId: tid })),
          judges: t.judges,
        });
      } else if (submitScorecard && t.dataset && t.harness) {
        rec = await submitScorecard({
          tenant,
          submittedBy: schedule.createdBy, // fired run = creator's identity (budget → tenant, private-repo connection resolve)
          origin: { source: "schedule" }, // provenance — stamp that this is a schedule fire
          dataset: t.dataset,
          harness: t.harness,
          judges: t.judges,
          ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
          ...(t.concurrency !== undefined ? { concurrency: t.concurrency } : {}),
          ...(t.trials !== undefined ? { trials: t.trials } : {}),
          ...(t.cases !== undefined ? { cases: t.cases } : {}),
        });
      } else {
        // The schema's refine guarantees exactly one mode, so this is unreachable — but stay explicit rather than assert.
        throw new BadRequestError(
          "BAD_REQUEST",
          { id },
          "schedule runTemplate is neither a batch nor a pull definition.",
        );
      }
    } catch (err) {
      // A CONFIG-class submit failure is deterministic — the same fire fails the same way on every tick (deleted
      // dataset/harness, revoked credentials/authz, invalid template, exhausted budget). Firing on is pure noise:
      // AUTO-DISABLE with a visible reason (the same pattern as creator-left) and pause the Temporal schedule.
      // Transient failures rethrow — the workflow's activity retry owns those.
      const failure = classifyFailure(err, "dispatch");
      if (failure.class === "config") {
        const updated = await this.deps.store.update(
          tenant,
          id,
          Schedule.from(schedule).autoDisable(`${failure.code} — ${failure.message}`, this.now()),
        );
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

// The create-path Temporal sync rolls the DB record back when ensure fails. If the rollback itself fails,
// the record is orphaned (exists in the DB but never fires) — that must be LOG-able, not `.catch(() => {})`
// silence. The surfaced error stays the ORIGINAL ensure failure (same class → same HTTP status); the
// rollback failure rides along: AppError → `rollbackFailed`/`rollbackError` in the envelope data, plain
// Error → appended to the message (the only surface a raw error reliably exposes).
function markRollbackFailed(err: unknown, rollbackErr: unknown, scheduleId: string): unknown {
  const rollback = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
  if (err instanceof AppError) {
    // Every AppError subclass shares the (code, extra, message) constructor — rebuild the same subclass
    // (extra is readonly on a live instance) with the rollback outcome attached.
    const rebuild = err.constructor as new (
      code: AppError["code"],
      extra?: Record<string, unknown>,
      message?: string,
    ) => AppError;
    return new rebuild(
      err.code,
      { ...err.extra, schedule: scheduleId, rollbackFailed: true, rollbackError: rollback },
      err.message,
    );
  }
  if (err instanceof Error) {
    err.message = `${err.message} — rollback also failed, schedule '${scheduleId}' is orphaned (stored in the DB but never fires): ${rollback}`;
    return err;
  }
  return err; // a non-Error throw carries no attachable surface — rethrow as-is (pre-existing behavior)
}
