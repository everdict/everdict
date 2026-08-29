import type { TraceThreshold } from "@everdict/contracts";
import { spansToEvents, trajectoryMetricValue, trajectoryMetrics } from "@everdict/domain";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import { type SealInput, type TrajectoryStore, sealBody } from "../ports/trajectory-store.js";

// E4 perception (event-plumbing.md §3 wave 4 / native-observability): the owned store PERCEIVES, the log
// ANNOUNCES. Every trajectory passes through seal — run settles, the OTLP door, materialized imports,
// sandbox teardowns — so the threshold check is a DECORATOR on that one choke point (the same
// composition-root move as RevisionedWorkspaceFs and withRegisteredFact), never a per-caller fork.
// Announced only when the seal actually TOOK (`created`), so at-least-once callers never double-emit.
// Perception is best-effort by construction: a threshold read or emit failure never touches the seal.
export function withTracePerception(
  store: TrajectoryStore,
  deps: {
    // The tenant's configured thresholds (WorkspaceSettings.traceThresholds) — resolved per seal, so an
    // edit applies to the next trajectory without any restart.
    thresholdsFor: (tenant: string) => Promise<TraceThreshold[]>;
    events: PlatformEventEmitter;
  },
): TrajectoryStore {
  return {
    async seal(input) {
      const sealed = await store.seal(input);
      if (sealed.created) void perceive(input, deps).catch(() => undefined);
      return sealed;
    },
    // Options forwarded, never re-spelled: dropping `attemptId` here would silently turn an exact-identity
    // read back into the clock-resolved one, which is the very substitution that read exists to refuse.
    planes: (tenant, runId, opts) => store.planes(tenant, runId, opts),
    // The window travels whole — see NamingTrajectoryStore for why it is never destructured here.
    events: (tenant, runId, window) => store.events(tenant, runId, window),
    usage: (tenant, runId) => store.usage(tenant, runId),
    list: (tenant, opts) => store.list(tenant, opts),
    ingestedSince: (tenant, sinceIso) => store.ingestedSince(tenant, sinceIso),
    deleteOlderThan: (cutoffIso) => store.deleteOlderThan(cutoffIso),
    // The THIRD decorator in this chain, and the third that would have dropped an optional method silently.
    // Retention's enumeration has to reach the concrete store or the sweep deletes rows whose payload
    // objects nothing can name afterwards (arch-review 120).
    payloadRefsOlderThan: (cutoffIso, limit, after) => store.payloadRefsOlderThan(cutoffIso, limit, after),
  };
}

async function perceive(
  input: SealInput,
  deps: { thresholdsFor: (tenant: string) => Promise<TraceThreshold[]>; events: PlatformEventEmitter },
): Promise<void> {
  const thresholds = await deps.thresholdsFor(input.tenant);
  if (thresholds.length === 0) return;
  // Perception reads the same events a judge does — the projection when the body is the record, so a
  // threshold means the same thing whichever form the emitter sealed in.
  const body = sealBody(input);
  const metrics = trajectoryMetrics(body.spans !== undefined ? spansToEvents(body.spans) : body.events);
  for (const threshold of thresholds) {
    const value = trajectoryMetricValue(metrics, threshold.metric);
    if (value === undefined || value <= threshold.value) continue;
    const rounded = Math.round(value * 10_000) / 10_000;
    void deps.events.emit({
      workspace: input.tenant,
      kind: "trace.threshold_crossed",
      subject: { type: "run", id: input.runId },
      payload: {
        runId: input.runId,
        threshold: threshold.name,
        metric: threshold.metric,
        value: rounded,
        limit: threshold.value,
        source: input.source,
      },
      message: `Trace ${input.runId} crossed "${threshold.name}" — ${threshold.metric} ${rounded} > ${threshold.value}`,
    });
  }
}
