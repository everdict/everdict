import type { TrajectoryStore } from "@everdict/application-control";
import { groupOtlpExportByRun, spansToTraceEvents } from "@everdict/trace";

// The OTLP/HTTP door's core (native-observability N0, receiver embedded in the api per N-O2): group the
// export's spans by everdict.run_id, normalize through the SAME span→TraceEvent path the pull sources use,
// and seal each run's trajectory in the OWNED store. Rung-1 seal semantics apply: one seal per run, first
// write wins — a multi-batch export's later batches for an already-sealed run are rejected VISIBLY in the
// response (partialSuccess), never silently; batch-per-run exporters (flush-at-exit, the dogfood shape)
// arrive whole. Live append is the next rung.
export class OtlpIngestService {
  constructor(private readonly trajectories: TrajectoryStore) {}

  async ingest(tenant: string, body: unknown): Promise<{ sealedRuns: number; rejectedSpans: number }> {
    const { groups, missingRunId } = groupOtlpExportByRun(body);
    let sealedRuns = 0;
    let rejectedSpans = missingRunId;
    for (const [runId, spans] of groups) {
      const events = spansToTraceEvents(spans);
      const before = await this.trajectories.get(tenant, runId);
      if (before) {
        rejectedSpans += spans.length; // already sealed — evidence is never rewritten (first write wins)
        continue;
      }
      await this.trajectories.seal({ runId, tenant, source: "otlp", events });
      sealedRuns++;
    }
    return { sealedRuns, rejectedSpans };
  }
}
