import type { FastifySchema } from "fastify";

// The owned trajectory ledger's browse surface (native-observability N1 "look inward"): list the sealed
// evidence, newest first, and open one — Settings › Traces' primary section reads THIS, not a tenant's
// external platform. GET /runs/:id/trajectory stays the run-scoped twin (the run is the home for evidence
// that HAS a run).
export const trajectoryDocs: Record<string, FastifySchema> = {
  list: {
    summary: "List the workspace's sealed trajectories (the owned evidence ledger)",
    description:
      "Metas only ({runId, source, kind?, label?, preview?, eventCount, sealedAt}), newest first, cursor-paginated. " +
      "source says how the evidence arrived: run (our own execution), otlp (the OTLP door), import " +
      "(materialized pull-ingest); kind says WHAT it is (eval | agent | command | sandbox | analysis) and " +
      "label is its human handle (the case id, the agent, the harness) while preview is the one-line excerpt of " +
      "what it was asked to do (the member's message, the first tool call, the root span) — the label names the " +
      "producer and repeats across rows, the preview is what tells two rows apart. Open one via GET /trajectories/:id.",
    tags: ["runs"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "string", description: "page size (default 50, max 200)" },
        cursor: { type: "string", description: "opaque cursor from the previous page" },
        kind: { type: "string", description: "only this run family (eval | agent | command | sandbox | analysis)" },
      },
    },
    response: {
      200: { description: "{ items: TrajectoryMeta[], nextCursor? }" },
    },
  },
  get: {
    summary: "Open ONE PAGE of one sealed trajectory (meta + plane headers + a window of TraceEvents)",
    description:
      "The ledger's own detail read, keyed by the id the trajectory was sealed under (TrajectoryMeta.runId). " +
      "Works for every source — an otlp arrival or a materialized import has no run row, so the run-scoped " +
      "GET /runs/:id/trajectory cannot open it. Another workspace's (or an unknown) id is 404. " +
      "`events` is ONE WINDOW of ONE plane — the execution's own record (what judges score) unless `emitter` " +
      "names another. `segments` describes every emitter that contributed to this run — the execution itself " +
      "plus each `service:<service.name>` that pushed its own spans through the OTLP door — as HEADERS with " +
      "no events on them; the one flagged `execution: true` is the plane this response's events came from, " +
      "and any other is opened by passing its `emitter`. When `nextAfter` is present there is more: pass it " +
      "as `after`. A long-horizon run's trace does not fit in one response and never did — this route used " +
      "to try, and the memory it took was the whole control plane's. " +
      "409 when a plane was sealed before its events were split out and is too large to serve as one body: " +
      "that is a refusal naming the size and the repair, never an empty page, because a reader handed zero " +
      "events would conclude the run did nothing.",
    tags: ["runs"],
    params: {
      type: "object",
      properties: { id: { type: "string", description: "the id the trajectory was sealed under" } },
      required: ["id"],
    },
    querystring: {
      type: "object",
      properties: {
        emitter: { type: "string", description: "which plane to read; default = the execution's own" },
        after: { type: "string", description: "resume after this seq (echo `nextAfter` from the last page)" },
        limit: { type: "string", description: "events per page; clamped by the store" },
      },
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
