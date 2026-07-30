import type { TraceEvent } from "@everdict/contracts";

// The OWNED trajectory record (execution-model §6 / P5, native-observability rung 1): what happened, kept by
// US — the copy every judgment stands on ("never judge what you don't retain"). Rung 1 collapses live-append
// and seal into one write (eval traces arrive whole at settle) and keeps the body in Postgres jsonb — the
// same bytes the run row embeds today, so no size regression and NO evidence decay (presigned-URL offload
// would rot; the object-storage rung arrives with key-based refs). The port keeps rung 2 (ClickHouse) a
// swap, not a rewrite.
export interface TrajectoryMeta {
  runId: string;
  tenant: string;
  // Where the trajectory came from: our own execution, the OTLP door (N0), or a materialized import (a
  // pulled external trace copied BEFORE judging — provenance, not a live link).
  source: "run" | "otlp" | "import";
  eventCount: number;
  sealedAt: string;
}

export interface TrajectoryStore {
  // Seal a run's whole trajectory. IDEMPOTENT by runId — the first seal wins: a retried settle or a judged
  // write-back never rewrites evidence.
  seal(input: {
    runId: string;
    tenant: string;
    source: TrajectoryMeta["source"];
    events: TraceEvent[];
  }): Promise<TrajectoryMeta>;
  get(tenant: string, runId: string): Promise<{ meta: TrajectoryMeta; events: TraceEvent[] } | undefined>;
}
