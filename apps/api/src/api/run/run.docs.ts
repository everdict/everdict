import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SubmitBodySchema } from "./request/submit.js";
import { RunDetailResponseSchema } from "./response/run-detail.js";
import { RunListResponseSchema } from "./response/run-list.js";
import { RunResponseSchema } from "./response/run.js";

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
  list: {
    summary: "List runs",
    description:
      "Lists the workspace's runs. Requires runs:read (viewer+). Without a query, scorecard child runs are " +
      "hidden (standalone activity list); with ?scorecardId only that batch's child runs are returned " +
      "(case drill-down).",
    tags: ["run"],
    querystring: toJsonSchema(
      z.object({
        scorecardId: z.string().optional().describe("Return only this scorecard batch's child runs"),
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
