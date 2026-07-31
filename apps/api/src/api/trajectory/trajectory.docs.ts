import type { FastifySchema } from "fastify";

// The owned trajectory ledger's browse surface (native-observability N1 "look inward"): list the sealed
// evidence, newest first, and open one — Settings › Traces' primary section reads THIS, not a tenant's
// external platform. GET /runs/:id/trajectory stays the run-scoped twin (the run is the home for evidence
// that HAS a run).
export const trajectoryDocs: Record<string, FastifySchema> = {
  list: {
    summary: "List the workspace's sealed trajectories (the owned evidence ledger)",
    description:
      "Metas only ({runId, source, eventCount, sealedAt}), newest first, cursor-paginated. source says how the " +
      "evidence arrived: run (our own execution), otlp (the OTLP door), import (materialized pull-ingest). " +
      "Open one via GET /trajectories/:id.",
    tags: ["runs"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "string", description: "page size (default 50, max 200)" },
        cursor: { type: "string", description: "opaque cursor from the previous page" },
      },
    },
    response: {
      200: { description: "{ items: TrajectoryMeta[], nextCursor? }" },
    },
  },
  get: {
    summary: "Open one sealed trajectory (meta + every normalized TraceEvent, across every emitter)",
    description:
      "The ledger's own detail read, keyed by the id the trajectory was sealed under (TrajectoryMeta.runId). " +
      "Works for every source — an otlp arrival or a materialized import has no run row, so the run-scoped " +
      "GET /runs/:id/trajectory cannot open it. Another workspace's (or an unknown) id is 404. " +
      "`events` is the EXECUTION's own record (what judges score). `segments` describes every emitter that " +
      "contributed to this run — the execution itself plus each `service:<service.name>` that pushed its own " +
      "spans through the OTLP door — so a caller can read the whole system, not just the agent. Exactly one " +
      "segment omits `events`: that is the execution one, whose stream is the top-level `events`.",
    tags: ["runs"],
    params: {
      type: "object",
      properties: { id: { type: "string", description: "the id the trajectory was sealed under" } },
      required: ["id"],
    },
    response: {
      200: {
        description:
          "{ meta: { runId, source, eventCount, sealedAt }, events: TraceEvent[], " +
          "segments: [{ emitter, source, eventCount, t0?, sealedAt, events? }] }",
      },
      404: { description: "no such trajectory in this workspace" },
    },
  },
  ingestionGet: {
    summary: "The OTLP door's ingestion quota + usage (N3 admission lane)",
    description:
      "The effective events/hour bound (workspace override > operator default > unlimited), the last hour's " +
      "stored events (the store is the meter), and the operator retention TTL when set. Past the bound the " +
      "door refuses at 429 and lands trace.ingestion_throttled on the event log (cooldown-bounded).",
    tags: ["runs"],
    response: { 200: { description: "{ maxEventsPerHour?, source, usedLastHour, retentionDays? }" } },
  },
  ingestionSet: {
    summary: "Set (or clear) the workspace's ingestion quota override",
    description:
      "maxEventsPerHour: a positive integer, or null to clear the override (falling back to the operator " +
      "default). settings:write.",
    tags: ["runs"],
    response: { 200: { description: "{ maxEventsPerHour? }" } },
  },
  thresholdsGet: {
    summary: "Get the workspace's trace thresholds (E4 perception config)",
    description:
      "The tenant-configured bounds evaluated over EVERY trajectory at seal time — a crossing lands " +
      "trace.threshold_crossed on the event log (the triage agents' wake signal).",
    tags: ["runs"],
    response: { 200: { description: "{ thresholds: [{name, metric, value}] }" } },
  },
  thresholdsSet: {
    summary: "Replace the workspace's trace thresholds",
    description:
      "Full replacement (like every settings list). metric: usd | total_tokens | llm_calls | tool_calls | " +
      "tool_failures | events | latency_ms_max; value is the exceeds-bound (strictly greater). Applies to the " +
      "next sealed trajectory — no restart. settings:write.",
    tags: ["runs"],
    response: { 200: { description: "{ thresholds }" } },
  },
};
