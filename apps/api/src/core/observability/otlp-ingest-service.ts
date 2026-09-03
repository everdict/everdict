import type { PlatformEventEmitter, TrajectoryStore } from "@everdict/application-control";
import { RateLimitError, UpstreamError } from "@everdict/contracts";
import type { TraceSpan } from "@everdict/contracts";
import { groupOtlpTraceSpansByRun, partitionTraceSpansByService } from "@everdict/trace";

// How often a throttled tenant is ANNOUNCED (the fact), independent of how often it is refused (every
// request). A retrying firehose reads as one signal on the log, not a flood.
const THROTTLE_FACT_COOLDOWN_MS = 15 * 60_000;

// A plane's absolute anchor: when its earliest span started. Undefined when no span carries a usable
// start — a reader keeps that plane on its own axis rather than aligning it against a guess.
function isoOfEarliestStart(spans: TraceSpan[]): string | undefined {
  const starts = spans.map((span) => Date.parse(span.startedAt)).filter((ms) => Number.isFinite(ms) && ms > 0);
  return starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : undefined;
}

// The OTLP/HTTP door's core (native-observability N0, receiver embedded in the api per N-O2): group the
// export's spans by everdict.run_id and seal each run's trajectory in the OWNED store.
//
// N6: the door no longer FLATTENS. It used to parse real OTLP spans and then call `spansToTraceEvents`
// before sealing — a tenant sent us a tree and we stored a list, which the viewer then guessed back into a
// tree. Now the spans ARE the record (trace id, kind, status, span events, resource kept separate from
// attributes), and the events a judge reads are projected from them on the way out.
//
// The MULTI-PLANE rung: a run is a system, not one process. Spans are grouped a second time by OTel's own
// `service.name`, and each service seals as its OWN segment (`service:<name>`) — so the agent under test,
// the orchestrator's account of where it ran, and every service the agent drives land in ONE trajectory
// without ever rewriting each other's bytes. Seal semantics are unchanged where they matter: first write
// wins PER EMITTER, so a retried batch is still refused VISIBLY in the response (partialSuccess) and never
// silently. What changed is that a second SERVICE is no longer mistaken for a retry.
//
// N3 admission lane: a trace firehose is the data-plane twin of runaway fan-out, so the door carries the
// same governance grammar — a per-tenant events/hour quota (workspace override, else the operator default)
// refused at 429, never a silent drop. The STORE is the meter (ingestedSince), so the count survives
// restarts and replicas without a separate counter to drift.
export class OtlpIngestService {
  private readonly lastThrottleFactAt = new Map<string, number>();

  constructor(
    private readonly trajectories: TrajectoryStore,
    private readonly deps: {
      // The workspace's quota override (WorkspaceSettings.traceIngestion) — resolved per request.
      quotaFor?: (tenant: string) => Promise<{ maxEventsPerHour?: number } | undefined>;
      defaultMaxEventsPerHour?: number; // operator default (EVERDICT_INGEST_MAX_EVENTS_PER_HOUR); unset = unlimited
      events?: PlatformEventEmitter; // trace.ingestion_throttled (cooldown-bounded)
      now?: () => number;
    } = {},
  ) {}

  async ingest(tenant: string, body: unknown): Promise<{ sealedRuns: number; rejectedSpans: number }> {
    const { groups, missingRunId } = groupOtlpTraceSpansByRun(body);
    const normalized = [...groups].map(([runId, spans]) => ({
      runId,
      // One plane per emitting service — OTel's own `service.name`, read from the resource where it belongs.
      // t0 is the plane's earliest span start, the anchor a cross-plane reader aligns the planes on.
      planes: [...partitionTraceSpansByService(spans)].map(([service, planeSpans]) => ({
        emitter: service !== undefined ? `service:${service}` : "otlp",
        spanCount: planeSpans.length,
        t0: isoOfEarliestStart(planeSpans),
        spans: planeSpans,
      })),
    }));
    // The meter counts SPANS now: that is the unit that arrives at an OTLP door, and it is the unit every
    // other OTel-speaking system quotas on.
    await this.admit(
      tenant,
      normalized.reduce((sum, group) => sum + group.planes.reduce((n, plane) => n + plane.spanCount, 0), 0),
    );
    let sealedRuns = 0;
    let rejectedSpans = missingRunId;
    for (const group of normalized) {
      let tookAny = false;
      for (const plane of group.planes) {
        const sealed = await this.trajectories.seal({
          runId: group.runId,
          tenant,
          source: "otlp",
          emitter: plane.emitter,
          spans: plane.spans,
          ...(plane.t0 !== undefined ? { t0: plane.t0 } : {}),
        });
        // This emitter already sealed — evidence is never rewritten (first write wins, per plane).
        if (sealed.created) tookAny = true;
        else rejectedSpans += plane.spanCount;
      }
      if (tookAny) sealedRuns++;
    }
    return { sealedRuns, rejectedSpans };
  }

  // The quota check (N3): workspace override, else the operator default, else unlimited. Refusal is loud
  // twice over — 429 to the exporter, trace.ingestion_throttled on the log (cooldown-bounded).
  private async admit(tenant: string, incomingEvents: number): Promise<void> {
    if (incomingEvents === 0) return;
    // ── AN UNREADABLE QUOTA IS NOT "NO OVERRIDE" (rule `protocol` L2, perf review) ──────────────────
    //
    // This read was `quotaFor?.(tenant).catch(() => undefined)`, and `undefined` is the arm that means "this
    // workspace set no override, use the operator default". So a settings-store outage did not look like an
    // outage: it looked like a workspace that had never configured a quota, and admission then proceeded
    // under a limit nobody had chosen — silently over a workspace that had set a LOWER one, silently under a
    // workspace that had raised it. It fails exactly when the database is already unwell, which is when the
    // door most needs to hold.
    //
    // Refusing is the fail-closed side here and it is cheap: OTLP exporters retry, so a transient failure
    // costs a retry rather than evidence. The throw is the OUTCOME (this push is refused), never a signal
    // meaning "somebody deal with it later" — which is the shape L2 bans.
    const override = await this.readQuota(tenant);
    const limit = override?.maxEventsPerHour ?? this.deps.defaultMaxEventsPerHour;
    if (limit === undefined) return;
    const now = this.deps.now?.() ?? Date.now();
    const used = await this.trajectories.ingestedSince(tenant, new Date(now - 3_600_000).toISOString());
    if (used.events + incomingEvents <= limit) return;
    const last = this.lastThrottleFactAt.get(tenant) ?? 0;
    if (now - last >= THROTTLE_FACT_COOLDOWN_MS) {
      this.lastThrottleFactAt.set(tenant, now);
      void this.deps.events?.emit({
        workspace: tenant,
        kind: "trace.ingestion_throttled",
        subject: { type: "workspace", id: tenant },
        payload: { usedLastHour: used.events, incoming: incomingEvents, limit },
        message: `Trace ingestion throttled — ${used.events} events in the last hour + ${incomingEvents} incoming > ${limit}.`,
      });
    }
    throw new RateLimitError(
      "RATE_LIMITED",
      { usedLastHour: used.events, incoming: incomingEvents, limit },
      `Trace ingestion quota exceeded: ${used.events} events in the last hour + ${incomingEvents} incoming > ${limit}. Retry later or raise the workspace quota.`,
    );
  }

  // The workspace's own ceiling, or the honest absence of one. An outage is neither.
  private async readQuota(tenant: string): Promise<{ maxEventsPerHour?: number } | undefined> {
    if (this.deps.quotaFor === undefined) return undefined;
    try {
      return await this.deps.quotaFor(tenant);
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { tenant },
        `Trace ingestion refused: the workspace's ingestion quota could not be read, so admission cannot be decided (${
          err instanceof Error ? err.message : String(err)
        }). Retry — exporters retry this.`,
      );
    }
  }
}
