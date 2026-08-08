import {
  AppError,
  BadRequestError,
  NotFoundError,
  type ScheduleOverlapPolicy,
  type ScheduleRecord,
  type ScheduleRunTemplate,
} from "@everdict/contracts";
import { Schedule, type ScheduleSpec, classifyFailure } from "@everdict/domain";
import type { AgentReportRunner } from "../ports/agent-report-runner.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ScheduleStore } from "../ports/schedule-store.js";
import type { PullIngestInput } from "../scorecard/scorecard-requests.js";
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
  // Optional: every everdict-managed schedule the driver's backend currently holds, with the tenant each
  // fires for. Powers reconcile(): the DB is SSOT, so a held schedule whose record is gone is an orphan the
  // service deletes (it would otherwise fire a doomed workflow on every tick, forever).
  listManaged?(): Promise<Array<{ id: string; tenant: string }>>;
}

// Read response = stored record + (if a driver is present) the next fire times computed by Temporal. Not persisted — attached at read time.
export type ScheduleRecordWithNext = ScheduleRecord & { nextFireTimes?: string[] };

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  // E3 time events (event-plumbing.md §6): every fire lands schedule.fired on the log — Temporal stays the
  // clock, its consumers become ordinary subscribers. Best-effort by the emit contract.
  events?: PlatformEventEmitter;
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
  // finalize uses it to record the terminal lastStatus; the completion notification itself comes from the scorecard's
  // onComplete (schedule-branded via origin.source === "schedule" — see NotificationService.notifyScorecard).
  scorecardStatus?: (scorecardId: string) => Promise<string | undefined>;
  // Called on a REPORT-mode fire — one headless agent analysis turn over the template's View (analysis-studio V4).
  // Synchronous within the fire (the runner enforces the turn budget); the completion notification is emitted by the
  // apps/api runner adapter, not here. If not injected, a report-mode fire throws BadRequest.
  reportRunner?: AgentReportRunner;
  // Called on a REPORT-mode fire, BEFORE the agent turn — writes the View's numbers to the workspace filesystem
  // so the schedule accumulates a data record, not only a narrated one. Deliberately separate from the runner:
  // the snapshot is deterministic, the report is an interpretation of it, and the cheap deterministic half must
  // not be lost when the expensive interpretive half fails. Absent = no accumulation (a fire still reports).
  captureViewSnapshot?: (input: {
    tenant: string;
    viewId: string;
    createdBy: string;
    scheduleId: string;
  }) => Promise<unknown>;
  newId?: () => string;
  now?: () => string;
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

  // Reconcile the driver's held schedules to the DB (the SSOT) — the boot-time sweep for the leaks the
  // per-request paths could not prevent (a delete whose driver call failed under an older build, a DB reset
  // under a live Temporal). A held schedule with no record left is deleted; a genuine record is never
  // touched (ensure() owns keeping its definition in sync). Returns how many orphans were removed.
  async reconcile(): Promise<number> {
    const driver = this.deps.driver;
    if (!driver?.listManaged) return 0;
    const held = await driver.listManaged();
    let removed = 0;
    for (const { id, tenant } of held) {
      if ((await this.deps.store.get(tenant, id)) !== undefined) continue;
      try {
        await driver.remove(id);
        removed += 1;
      } catch (err) {
        console.warn(
          `[schedule] reconcile could not remove orphan schedule ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (removed > 0) console.warn(`[schedule] reconcile removed ${removed} orphan Temporal schedule(s)`);
    return removed;
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
  // Records lastFired/last* and returns the submitted scorecard id. If no firer is configured, BadRequest (Temporal-less dev).
  async fire(tenant: string, id: string): Promise<{ scorecardId?: string; artifactId?: string }> {
    let schedule: ScheduleRecord;
    try {
      schedule = await this.getRecord(tenant, id); // 404
    } catch (err) {
      // A fire for a record that no longer exists means the DRIVER still holds a schedule the DB (the SSOT)
      // has dropped — a leaked delete. Self-heal at the choke point every orphan inevitably reaches: delete
      // the driver's schedule so it stops firing, then still answer 404 (this fire has nothing to run).
      if (err instanceof NotFoundError) await this.deps.driver?.remove(id).catch(() => undefined); // best-effort — the next tick retries
      throw err;
    }
    const t = schedule.runTemplate;
    // The tick is a FACT: a time-driven agent is just a subscription on schedule.fired (+ a scheduleId
    // filter — filters read the payload, so the id rides there too). The fire never depends on the emit.
    void this.deps.events?.emit({
      workspace: tenant,
      kind: "schedule.fired",
      subject: { type: "schedule", id },
      actor: schedule.createdBy,
      payload: {
        scheduleId: id,
        name: schedule.name,
        mode: t.report ? "report" : t.pull ? "pull" : "scorecard",
      },
      message: `Schedule "${schedule.name}" fired`,
    });
    const { submitScorecard, ingestPull, listTraceIds, reportRunner } = this.deps;
    // Firer-configured checks live OUTSIDE the try: a missing firer is a deployment-config problem, not a schedule-config
    // one, so it must NOT auto-disable the schedule (the catch's classifyFailure would). Each mode needs its own firer.
    if (t.report) {
      if (!reportRunner)
        throw new BadRequestError("BAD_REQUEST", { id }, "Report firer is not configured (report firing disabled).");
      // Capture first, report second. The snapshot is the deterministic half — the View's numbers as of this
      // fire, on the filesystem — and it must survive an agent turn that errors or exhausts its budget. A
      // capture failure is never allowed to fail the fire either: accumulation is an addition to reporting,
      // not a precondition for it, so a filesystem outage degrades to "no snapshot this week".
      if (this.deps.captureViewSnapshot) {
        try {
          await this.deps.captureViewSnapshot({
            tenant,
            viewId: t.report.view,
            createdBy: schedule.createdBy,
            scheduleId: id,
          });
        } catch {
          /* accumulation is best-effort — the report below is what the schedule promised */
        }
      }
      // Report fire — one headless agent analysis turn over the View; no scorecard is produced. The same
      // catch-classify applies: a deterministic failure (deleted view, revoked creator) auto-disables the schedule.
      try {
        const result = await reportRunner.run({
          tenant,
          createdBy: schedule.createdBy,
          scheduleId: id,
          scheduleName: schedule.name,
          view: t.report.view,
          ...(t.report.instructions !== undefined ? { instructions: t.report.instructions } : {}),
          ...(t.report.compare !== undefined ? { compare: t.report.compare } : {}),
        });
        await this.deps.store.update(tenant, id, {
          lastFiredAt: this.now(),
          lastStatus: result.artifactId !== undefined ? "reported" : "report-empty",
          ...(result.artifactId !== undefined ? { lastArtifactId: result.artifactId } : {}),
          updatedAt: this.now(),
        });
        return result.artifactId !== undefined ? { artifactId: result.artifactId } : {};
      } catch (err) {
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
    }
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
          origin: { source: "schedule", scheduleId: id }, // provenance — stamp WHICH schedule fired this (run-history lookup)
          // correlate:"id" — the ids ARE the platform's real trace ids (from listTraceIds), so fetch by id.
          source: { name: t.pull.source, correlate: t.pull.correlate ?? "id" },
          runs: traceIds.map((tid) => ({ caseId: tid, runId: tid })),
          judges: t.judges,
        });
      } else if (submitScorecard && t.dataset && t.harness) {
        rec = await submitScorecard({
          tenant,
          submittedBy: schedule.createdBy, // fired run = creator's identity (budget → tenant, private-repo connection resolve)
          origin: { source: "schedule", scheduleId: id }, // provenance — stamp WHICH schedule fired this (run-history lookup)
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
    return { scorecardId: rec.id };
  }

  // The fired scorecard's status (workflow poll-to-terminal). undefined if not configured.
  scorecardStatus(scorecardId: string): Promise<string | undefined> {
    return this.deps.scorecardStatus?.(scorecardId) ?? Promise.resolve(undefined);
  }

  // Finalize (called by the workflow after poll-to-terminal) — record the fired scorecard's terminal status on the
  // schedule (last-run status for the list/detail). The creator's completion notification is emitted by the scorecard's
  // own onComplete (schedule-branded via origin.source === "schedule"), so finalize no longer notifies.
  async finalize(tenant: string, id: string, scorecardId: string): Promise<void> {
    await this.getRecord(tenant, id); // 404 (if the schedule was deleted, nothing more to do)
    const status = await this.scorecardStatus(scorecardId);
    if (status !== undefined) await this.deps.store.update(tenant, id, { lastStatus: status, updatedAt: this.now() });
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
