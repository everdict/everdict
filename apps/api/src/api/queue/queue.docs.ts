import {
  QueueEntryCancelResponseSchema,
  QueueEntryPromoteResponseSchema,
  QueueSnapshotResponseSchema,
} from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the workload-visibility routes — documentation only (no-op compilers;
// rule api-layer). Attached by queue.routes.ts as { schema: queueDocs.<key> }.
const docs = {
  metrics: {
    summary: "Prometheus metrics (operator scrape)",
    description:
      "Prometheus text exposition (version 0.0.4), OPERATOR-ONLY: the exposition carries per-workspace labels, " +
      "so the scrape is gated by the operator token (`Authorization: Bearer <EVERDICT_METRICS_TOKEN>` — one " +
      "`bearer_token` line in the scrape config), fail-closed like /internal/**. Counters/histograms accumulate " +
      "at the dispatch seam; gauges sample live components. 404 when metrics or the token are not configured.",
    tags: ["queue"],
    produces: ["text/plain"],
    response: {
      200: { description: "Prometheus text exposition (text/plain; version=0.0.4)", type: "string" },
      ...errorResponses(403, 404),
    },
  },
  queue: {
    summary: "Get the work-queue snapshot",
    description:
      "Snapshot of running/waiting (FIFO)/next-scheduled work per runtime lane, split into workspace lanes " +
      "(default backend + registered runtimes) and the requester's personal self-hosted lanes (another " +
      "member's personal runner queue is invisible). Includes the scheduler admission view per lane " +
      "(in-flight, envelopes, circuit breaker) and — when the live scheduler is wired — this workspace's " +
      "waiting entries in the scheduler's effective scan order (scheduler.entries; position 1 is next). " +
      "Requires runs:read (viewer+), workspace-scoped.",
    tags: ["queue"],
    response: {
      200: { description: "Queue snapshot", ...toJsonSchema(QueueSnapshotResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  cancelEntry: {
    summary: "Cancel a waiting scheduler queue entry",
    description:
      "Remove ONE waiting entry from the control-plane scheduler queue (by its scheduler.entries id) and settle " +
      "its dispatch as CANCELLED — the kill switch for a stray or mis-queued job (e.g. a judge job left behind " +
      "by a reclaimed batch). In-flight work is untouched (cancel the run/scorecard for that). Requires " +
      "runs:submit (member+); another workspace's entry — or one already placed/settled — is 404.",
    tags: ["queue"],
    params: {
      type: "object",
      required: ["entryId"],
      properties: { entryId: { type: "string", description: "The scheduler.entries id" } },
    },
    response: {
      200: { description: "Cancelled", ...toJsonSchema(QueueEntryCancelResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  promoteEntry: {
    summary: "Move a waiting scheduler queue entry to the front",
    description:
      "Reorder the control-plane scheduler queue: move ONE waiting entry (by its scheduler.entries id) to the " +
      "front of the effective scan order — 'run this next'. Fairness bookkeeping is untouched; repeated " +
      "promotions stack newest-first. Requires runs:submit (member+); another workspace's entry — or one " +
      "already placed/settled — is 404.",
    tags: ["queue"],
    params: {
      type: "object",
      required: ["entryId"],
      properties: { entryId: { type: "string", description: "The scheduler.entries id" } },
    },
    response: {
      200: { description: "Promoted", ...toJsonSchema(QueueEntryPromoteResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const queueDocs: Record<keyof typeof docs, FastifySchema> = docs;
