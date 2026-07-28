import { ScheduleService } from "@everdict/application-control";
import type {
  AgentReportRunner,
  NotificationService,
  ScorecardService,
  TraceSourceService,
} from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
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
    // Optional — enables PULL-mode schedules (judge a rolling window of a trace source). Absent = batch-only firing.
    traceSourceService?: TraceSourceService;
    // Optional — REPORT-mode completion fan-out (feed + Mattermost + agent event). Absent = report fires silently.
    notificationService?: NotificationService;
  },
): ScheduleService {
  const { scheduleStore, scorecardService, traceSourceService, notificationService } = deps;
  const temporalAddress = process.env.EVERDICT_TEMPORAL_ADDRESS;
  // REPORT-mode firer (analysis-studio V4): a headless analysis turn on the agent service over its internal,
  // x-internal-token-gated route. Wired only when the agent bridge env is present (the same pair the agent-event
  // sink uses); absent → a report-mode fire cleanly 400s. The adapter also owns the completion notification
  // (best-effort — a notify failure never fails the fire).
  const agentUrl = process.env.AGENT_SERVICE_URL;
  const agentInternalToken = process.env.AGENT_INTERNAL_TOKEN;
  const reportRunner: AgentReportRunner | undefined =
    agentUrl && agentInternalToken
      ? {
          run: async (input) => {
            let res: Response;
            try {
              // The agent's internal surface says `workspace` (the /agent/events precedent); the port input says
              // `tenant` (control-plane vocabulary) — map explicitly, never spread (a live 400 caught the drift).
              res = await fetch(new URL("/internal/report", agentUrl), {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-token": agentInternalToken },
                body: JSON.stringify({
                  workspace: input.tenant,
                  createdBy: input.createdBy,
                  scheduleId: input.scheduleId,
                  scheduleName: input.scheduleName,
                  view: input.view,
                  ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
                  ...(input.compare !== undefined ? { compare: input.compare } : {}),
                }),
              });
            } catch (err) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { scheduleId: input.scheduleId },
                `agent report service unreachable: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (!res.ok)
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { scheduleId: input.scheduleId, status: res.status },
                `agent report turn failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
              );
            const body = (await res.json()) as { sessionId: string; artifactId?: string };
            await notificationService
              ?.notifyReport(input.tenant, {
                scheduleId: input.scheduleId,
                scheduleName: input.scheduleName,
                viewId: input.view,
                ...(body.artifactId !== undefined ? { artifactId: body.artifactId } : {}),
                createdBy: input.createdBy,
              })
              .catch(() => undefined); // fire-and-forget — the notification never fails the report
            return body;
          },
        }
      : undefined;
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
            (await traceSourceService.listTraces(tenant, source, opts)).traces.map((t) => t.id),
        }
      : {}),
    // Terminal status recorded on the schedule at finalize; the creator's completion notification is emitted by the
    // scorecard's own onComplete (schedule-branded via origin.source === "schedule").
    scorecardStatus: async (id) => (await scorecardService.get(id))?.status,
    ...(reportRunner ? { reportRunner } : {}),
  });
  ref.set(scheduleService);
  return scheduleService;
}
