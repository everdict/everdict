import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { QueueSnapshotResponseSchema } from "./response/queue-snapshot.js";

// OpenAPI descriptors for the workload-visibility routes — documentation only (no-op compilers;
// rule api-layer). Attached by queue.routes.ts as { schema: queueDocs.<key> }.
const docs = {
  metrics: {
    summary: "Prometheus metrics",
    description:
      "Prometheus text exposition (version 0.0.4). UNAUTHENTICATED by design — standard scrape practice; the " +
      "path is expected to be firewalled. Counters/histograms accumulate at the dispatch seam; gauges sample " +
      "live components. 404 when metrics are not configured.",
    tags: ["queue"],
    produces: ["text/plain"],
    response: {
      200: { description: "Prometheus text exposition (text/plain; version=0.0.4)", type: "string" },
      ...errorResponses(404),
    },
  },
  queue: {
    summary: "Get the work-queue snapshot",
    description:
      "Snapshot of running/waiting (FIFO)/next-scheduled work per runtime lane, split into workspace lanes " +
      "(default backend + registered runtimes) and the requester's personal self-hosted lanes (another " +
      "member's personal runner queue is invisible). Includes the scheduler admission view per lane " +
      "(in-flight, envelopes, circuit breaker). Requires runs:read (viewer+), workspace-scoped.",
    tags: ["queue"],
    response: {
      200: { description: "Queue snapshot", ...toJsonSchema(QueueSnapshotResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const queueDocs: Record<keyof typeof docs, FastifySchema> = docs;
