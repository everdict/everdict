import type { NotificationService } from "@everdict/application-control";
import { ScheduleService } from "@everdict/application-control";
import type { ScorecardService, TraceSourceService } from "@everdict/application-control";
import type { ScheduleStore } from "@everdict/db";
import { TemporalScheduleDriver } from "../core/schedule/temporal-schedule-driver.js";

// The one place the schedule↔membership↔scorecard construction cycle is expressed.
//
// The cycle: MembershipService needs a member-removal hook that auto-disables a departed member's scheduled evals
// (scheduleService.disableByCreator) — but MembershipService is built early (buildIntegrations' commentService reads
// it), while ScheduleService can only be built LATE (it needs the already-constructed ScorecardService). So the hook
// closes over this late-bound reference instead of the service directly: the closure is only invoked at runtime (when
// a member actually leaves), by which point wireScheduleService has run and the reference resolves.
export class ScheduleServiceRef {
  private value: ScheduleService | undefined;

  set(service: ScheduleService): void {
    this.value = service;
  }

  // The member-removal hook resolves the service here. It is never called before wireScheduleService (a member can
  // only leave a running control plane, well after boot wiring completes), so an unset reference is a wiring bug.
  require(): ScheduleService {
    if (!this.value) throw new Error("scheduleService referenced before wireScheduleService — boot wiring bug");
    return this.value;
  }
}

// Scheduled (cron) scorecards. SSOT = scheduleStore; when a Temporal address is set, sync the Schedule via
// TemporalScheduleDriver (firing enabled). Firing goes workflow → internal route → submitScorecard here. Unset →
// CRUD only (firing disabled, dev). Constructs the service and publishes it into the shared reference (closing the cycle).
export function wireScheduleService(
  ref: ScheduleServiceRef,
  deps: {
    scheduleStore: ScheduleStore;
    scorecardService: ScorecardService;
    notificationService: NotificationService;
    // Optional — enables PULL-mode schedules (judge a rolling window of a trace source). Absent = batch-only firing.
    traceSourceService?: TraceSourceService;
  },
): ScheduleService {
  const { scheduleStore, scorecardService, notificationService, traceSourceService } = deps;
  const temporalAddress = process.env.EVERDICT_TEMPORAL_ADDRESS;
  const scheduleService = new ScheduleService({
    store: scheduleStore,
    ...(temporalAddress ? { driver: new TemporalScheduleDriver({ address: temporalAddress }) } : {}),
    submitScorecard: (sc) => scorecardService.submit(sc),
    // Pull-mode fire — judge the recent traces of a rolling window (no harness run). listTraceIds enumerates the window
    // via the trace-source pool; only wired when that service is configured (else a pull-mode fire cleanly 400s).
    ingestPull: (input) => scorecardService.ingestPull(input),
    ...(traceSourceService
      ? {
          listTraceIds: async (tenant, source, opts) =>
            (await traceSourceService.listTraces(tenant, source, opts)).map((t) => t.id),
        }
      : {}),
    scorecardStatus: async (id) => (await scorecardService.get(id))?.status,
    // Regression alert: diff previous↔this schedule run (both must be complete) → Mattermost on regression (completion notification is separate, via the scorecard onComplete).
    diffScorecards: (tenant, baselineId, candidateId) => scorecardService.diff(tenant, baselineId, candidateId),
    notifyRegression: (tenant, payload) => notificationService.notifyRegression(tenant, payload),
  });
  ref.set(scheduleService);
  return scheduleService;
}
