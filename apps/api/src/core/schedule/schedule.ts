import { BadRequestError, ForbiddenError } from "@everdict/core";
import type { ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunTemplate } from "@everdict/db";

// The domain model for a scheduled (cron) scorecard. Wraps the persistence record (@everdict/db
// ScheduleRecord — shapes unchanged); guard methods are the SSOT for what is legal, and transitions return
// the store patch. Schedules have NO status state machine (enabled is freely toggled), so this model
// deliberately owns only the real rules: cron validity, the content-edit permission, the enabled/paused
// Temporal semantics, and the auto-disable transition. Plain bookkeeping writes (fire's last* stamp,
// finalize's lastStatus) stay literal in the service. docs/architecture/rich-domain-core.md

// Lightweight structural check of a 5-field cron — firing (Temporal Schedule) parses precisely, so here we
// only reject obviously malformed input. Each field: * | n | n-m, optional step (/k), comma list.
// (Value-range semantics are enforced by Temporal.)
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

// The patch a transition computes — the service persists it verbatim (store.update(tenant, id, patch)).
export type ScheduleTransition = Partial<ScheduleRecord>;

// Minimal spec handed to a Temporal Schedule (the driver converts cron→Schedule). The firing workflow's
// args are (tenant, id).
export interface ScheduleSpec {
  id: string;
  tenant: string;
  cron: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  paused: boolean; // = !enabled
}

// The caller identity at the update boundary (route/MCP). Absent = internal call/test → the gate is skipped.
export interface ScheduleActor {
  subject: string;
  isAdmin: boolean;
}

export interface NewScheduleInput {
  id: string;
  tenant: string;
  createdBy: string; // submitter subject — the fired run's submittedBy (budget → tenant, private-repo connection resolve)
  name: string;
  cron: string;
  timezone?: string; // default "UTC"
  overlapPolicy?: ScheduleOverlapPolicy; // default "skip"
  enabled?: boolean; // default true
  runTemplate: ScheduleRunTemplate;
  now: string;
}

export class Schedule {
  private constructor(private readonly record: ScheduleRecord) {}

  static from(record: ScheduleRecord): Schedule {
    return new Schedule(record);
  }

  // Throwing form of isValidCron — create and update share this exact 400.
  static assertValidCron(cron: string): void {
    if (!isValidCron(cron))
      throw new BadRequestError("BAD_REQUEST", { cron }, `cron expression is invalid (5 fields required): '${cron}'`);
  }

  // The only place a schedule record is assembled — create's literal (defaults UTC/skip/enabled) lives here.
  static newRecord(input: NewScheduleInput): ScheduleRecord {
    Schedule.assertValidCron(input.cron);
    return {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      overlapPolicy: input.overlapPolicy ?? "skip",
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
      runTemplate: input.runTemplate,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // A 'content edit' changes any field other than enabled. Content is creator/admin gated (firing runs
  // under the creator's identity: budget, private-repo connections); pause/resume (enabled only) is member+.
  static editsContent(patch: object): boolean {
    return Object.keys(patch).some((k) => k !== "enabled");
  }

  // Enabled = live in Temporal; disabled = paused (never fires). disableByCreator targets only enabled ones.
  isEnabled(): boolean {
    return this.record.enabled;
  }

  // Content-edit permission: the schedule creator or a workspace admin. No actor (internal call) = allowed.
  canEditContent(actor?: ScheduleActor): boolean {
    return !actor || actor.subject === this.record.createdBy || actor.isAdmin;
  }

  // Guard an update patch: content edits require canEditContent; a pause-only patch is never gated.
  assertCanEdit(patch: object, actor?: ScheduleActor): void {
    if (!Schedule.editsContent(patch) || this.canEditContent(actor)) return;
    throw new ForbiddenError(
      "FORBIDDEN",
      { id: this.record.id, action: "schedules:edit" },
      "You do not have permission to edit this schedule (schedule creator or workspace admin only).",
    );
  }

  // The record projected as the Temporal sync spec — the paused = !enabled semantic lives here
  // (a disabled schedule is paused in Temporal → does not fire).
  toTemporalSpec(): ScheduleSpec {
    return {
      id: this.record.id,
      tenant: this.record.tenant,
      cron: this.record.cron,
      timezone: this.record.timezone,
      overlapPolicy: this.record.overlapPolicy,
      paused: !this.record.enabled,
    };
  }

  // Auto-disable (creator left the workspace / a config-class fire failure): always pairs enabled=false
  // with a visible "Auto-disabled: <reason>" lastStatus, capped at 300 chars (lastStatus is a short status
  // surface, not a log). Idempotent over an already-disabled schedule — there is no state machine to guard.
  autoDisable(reason: string, now: string): ScheduleTransition {
    return { enabled: false, lastStatus: `Auto-disabled: ${reason}`.slice(0, 300), updatedAt: now };
  }
}
