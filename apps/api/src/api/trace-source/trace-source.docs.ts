import {
  TraceProbeResultSchema,
  TraceSourceAssignmentsResponseSchema,
  TraceSourceRosterSchema,
  TraceSourceUpsertResponseSchema,
} from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for workspace trace sources — the INBOUND mirror of trace sinks: pull the trace a
// dev-cluster-deployed harness emitted to its observability platform, after a case runs, for grading/judging.
// (rule api-layer: schemas document, never validate/serialize — the compilers are no-ops.)
const docs = {
  list: {
    summary: "List workspace trace sources",
    description:
      "Registered inbound sources (OTel/MLflow/Langfuse/LangSmith/Phoenix) plus the per-harness selection map. " +
      "Pull is opt-in: a harness with no selection uses its inline spec.traceSource (or no pull). Read is " +
      "harnesses:read (viewer+ — name references/URLs only, no secret values). Design: docs/service-harness.md.",
    tags: ["trace-source"],
    response: {
      200: { description: "Source roster + per-harness assignments", ...toJsonSchema(TraceSourceRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  upsert: {
    summary: "Register or update a trace source",
    description:
      "Name-keyed upsert (declarative full replace). Put the auth token value into the SecretStore first and pass " +
      "only its name. correlate:'tag' (search the everdict.run_id the deployed agent tagged) needs `service` for " +
      "otel and `project` for mlflow/phoenix. Requires settings:write (admin) — per-harness selection is separate.",
    tags: ["trace-source"],
    body: toJsonSchema(
      z.object({
        name: z.string().min(1).describe("Source name (reference key)"),
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url().describe("Platform query API base URL"),
        authSecretName: z.string().min(1).optional().describe("SecretStore name of the auth-header value"),
        correlate: z.enum(["id", "tag"]).optional().describe("How this run's trace is found (default id)"),
        service: z.string().min(1).optional().describe("otel/jaeger tag-search scope (the agent's service.name)"),
        project: z.string().min(1).optional().describe("mlflow experiment_id / phoenix project (tag/span scope)"),
      }),
    ),
    response: {
      200: { description: "Stored source", ...toJsonSchema(TraceSourceUpsertResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  probe: {
    summary: "Test a trace source connection and discover its scopes",
    description:
      "Validate the base URL + resolved secret and list the platform's selectable scopes in one authed call " +
      "(mlflow experiments / phoenix|langfuse|langsmith projects / otel[jaeger] services) — used by the web form " +
      "to gate Save and populate the scope picker. A classified failure (reason set) is still a 200. Requires " +
      "settings:write (the probe resolves the workspace secret).",
    tags: ["trace-source"],
    body: toJsonSchema(
      z.object({
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url().describe("Platform query API base URL"),
        authSecretName: z.string().min(1).optional().describe("SecretStore name of the auth-header value"),
      }),
    ),
    response: {
      200: { description: "Probe outcome + discovered scopes", ...toJsonSchema(TraceProbeResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Remove a trace source",
    description:
      "Removes the named source and cleans up any per-harness selections that pointed at it (no dangling " +
      "references). Requires settings:write (admin).",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ name: z.string().describe("Source name") })),
    response: { 204: { description: "Removed", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  assign: {
    summary: "Select a trace source for a harness",
    description:
      "Per-harness opt-in: chooses which registered source everdict pulls this harness's case traces from. " +
      "source:null clears the selection (fall back to inline / no pull); an unregistered name is 400. Requires " +
      "harnesses:register (member+ — part of the harness config, unlike the admin-gated source registration).",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (selection is version-independent)") })),
    body: toJsonSchema(z.object({ source: z.string().min(1).nullable().describe("Source name, or null to deselect") })),
    response: {
      200: { description: "Updated per-harness selection map", ...toJsonSchema(TraceSourceAssignmentsResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const traceSourceDocs: Record<keyof typeof docs, FastifySchema> = docs;
