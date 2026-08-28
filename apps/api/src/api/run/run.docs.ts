import { RunDetailResponseSchema } from "@everdict/contracts/wire";
import { RunListResponseSchema } from "@everdict/contracts/wire";
import { RunResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SubmitBodySchema } from "./request/submit.js";

// OpenAPI descriptors for the run routes — documentation only (the server's validator/serializer compilers
// are no-ops; rule api-layer). Attached by run.routes.ts as { schema: runDocs.<key> }.
const docs = {
  submit: {
    summary: "Submit a run",
    description:
      "Async execution primitive: dispatches one eval case against a harness and returns 202 with the queued " +
      "record immediately — the result arrives by polling GET /runs/:id or via the optional webhook. " +
      "Workspace-scoped; requires the runs:submit action (member+). The submitter's subject resolves personal " +
      "connections for private-repo seeds. Budget caps admit with 402; queue backpressure returns 429.",
    tags: ["run"],
    body: toJsonSchema(SubmitBodySchema),
    response: {
      202: { description: "Run accepted (queued)", ...toJsonSchema(RunResponseSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  },
  get: {
    summary: "Get a run",
    description:
      "Reads one run record, workspace-scoped (another workspace's run reads 404 — no existence leak). " +
      "Requires runs:read (viewer+). While in flight, liveTrace carries best-effort deep-link coordinates " +
      "into the tenant's trace platform.",
    tags: ["run"],
    params: toJsonSchema(z.object({ id: z.string().describe("Run id") })),
    response: {
      200: { description: "The run record", ...toJsonSchema(RunDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  cancel: {
    summary: "Stop a running run",
    description:
      "User-initiated stop of a queued/running run: settles it `failed` with error code CANCELLED (the run " +
      "lifecycle's cancellation shape — the status union is not widened) and then frees its compute (a " +
      "dispatched managed job is killed, a still-queued scheduler entry dropped, a self-hosted lease revoked " +
      "so the runner aborts the case on its next heartbeat). Requires runs:submit (member+), workspace-scoped. " +
      "Re-cancelling an already-cancelled run is 200 and re-runs the teardown (idempotent); a succeeded / " +
      "otherwise-failed / suspended run and a scorecard child (stop the scorecard instead) are 409; a missing / " +
      "other-workspace / other-member's run is 404.",
    tags: ["run"],
    params: toJsonSchema(z.object({ id: z.string().describe("Run id") })),
    response: {
      200: { description: "The cancelled run record", ...toJsonSchema(RunResponseSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  trajectory: {
    summary: "Get ONE PAGE of a run's owned trajectory",
    description:
      "The sealed trajectory from the OWNED store (execution-model P5 — the copy every judgment stands on), " +
      "falling back to the run row's embed in the same shape during the dual-read window. meta.source says " +
      "which copy served (run | otlp | import | embed). Workspace-scoped; requires runs:read. " +
      "`events` is ONE WINDOW of ONE plane — the execution's own unless `emitter` names another; `segments` " +
      "lists every plane as a header. A long-horizon run's trace does not fit in one response: when " +
      "`nextAfter` is present, pass it as `after` for the following page.",
    tags: ["run"],
    params: toJsonSchema(z.object({ id: z.string().describe("Run id") })),
    querystring: toJsonSchema(
      z.object({
        emitter: z.string().optional().describe("which plane to read; default = the execution's own"),
        after: z.string().optional().describe("resume after this seq (echo `nextAfter` from the last page)"),
        limit: z.string().optional().describe("events per page; clamped by the store"),
      }),
    ),
    response: {
      200: {
        description: "The trajectory (meta + normalized TraceEvent[])",
        ...toJsonSchema(
          z.object({
            meta: z.object({ source: z.string(), eventCount: z.number(), sealedAt: z.string() }),
            events: z.array(z.unknown()),
          }),
        ),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List runs",
    description:
      "Lists the workspace's runs. Requires runs:read (viewer+). Without a query, scorecard child runs are " +
      "hidden (standalone activity list); with ?scorecardId only that batch's child runs are returned " +
      "(case drill-down) — each row then carries `canonical`, the batch's commit-receipt verdict on that " +
      "attempt (true = the case's answer, false = superseded, absent = no receipt for that case); with " +
      "?scope=all, standalone runs and scorecard children are returned together " +
      "(the activity console's all-executions view, grouped by scorecard in the UI).",
    tags: ["run"],
    querystring: toJsonSchema(
      z.object({
        scorecardId: z.string().optional().describe("Return only this scorecard batch's child runs"),
        scope: z
          .enum(["standalone", "all"])
          .optional()
          .describe("standalone (default) = children hidden; all = standalone runs + scorecard children"),
        runner: z
          .string()
          .optional()
          .describe("Return only runs a self-hosted runner executed (runner-detail activity feed)"),
        limit: z.string().optional().describe("Cap the number of rows returned (newest first)"),
        offset: z
          .string()
          .optional()
          .describe("Skip the first N rows before limit — offset pagination for the runner activity feed"),
      }),
    ),
    response: {
      200: { description: "Run records", ...toJsonSchema(RunListResponseSchema) },
      ...errorResponses(401, 403),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const runDocs: Record<keyof typeof docs, FastifySchema> = docs;
