import { SpanAttrMappingSchema, TraceInspectResultSchema, TraceSummarySchema } from "@everdict/contracts";
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
      "only its name. `project` is required for mlflow (experiment) and phoenix (both to pull AND to export — traces " +
      "live inside it); otel correlate:'tag' needs `service`. correlate is a pull-only detail (default id). Requires " +
      "settings:write (admin) — per-harness pull/export selection is separate.",
    tags: ["trace-source"],
    body: toJsonSchema(
      z.object({
        name: z.string().min(1).describe("Source name (reference key)"),
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url().describe("Platform query API base URL"),
        authSecretName: z.string().min(1).optional().describe("SecretStore name of the auth-header value"),
        correlate: z.enum(["id", "tag"]).optional().describe("How a pulled trace is found (default id)"),
        service: z.string().min(1).optional().describe("otel/jaeger tag-search scope (the agent's service.name)"),
        project: z.string().min(1).optional().describe("mlflow experiment_id / phoenix|langfuse|langsmith project"),
        webUrl: z.string().url().optional().describe("export deep-link base when it differs from the endpoint"),
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
    summary: "Select a PULL trace source for a harness",
    description:
      "Per-harness opt-in: chooses which registered source everdict pulls this harness's case traces from. " +
      "source:null clears the selection (fall back to inline / no pull); an unregistered name is 400. Requires " +
      "harnesses:register (member+ — part of the harness config, unlike the admin-gated source registration).",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (selection is version-independent)") })),
    body: toJsonSchema(z.object({ source: z.string().min(1).nullable().describe("Source name, or null to deselect") })),
    response: {
      200: {
        description: "Updated per-harness PULL selection map",
        ...toJsonSchema(TraceSourceAssignmentsResponseSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  assignSink: {
    summary: "Select an EXPORT target (trace source) for a harness",
    description:
      "Per-harness opt-in: chooses which registered source this harness's judged scorecards export to (the source used " +
      "as an export target). source:null clears it (export off); an unregistered name or an otel source (pull-only) is " +
      "400. Same source pool as the pull selection — the direction is the use-site choice. Requires harnesses:register.",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (selection is version-independent)") })),
    body: toJsonSchema(z.object({ source: z.string().min(1).nullable().describe("Source name, or null to deselect") })),
    response: {
      200: {
        description: "Updated per-harness EXPORT selection map",
        ...toJsonSchema(TraceSourceAssignmentsResponseSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  listTraces: {
    summary: "List a trace source's recent traces",
    description:
      "Enumerate the recent traces (id + observability metrics: time/duration/tokens/cost/status/tags) the registered " +
      "platform holds within a scope — the settings observability browser and the judge wizard's sample picker. " +
      "scope defaults to the source's configured scope (mlflow experiment / phoenix|langfuse|langsmith project / " +
      "otel[jaeger] service). Read is harnesses:read.",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ name: z.string().describe("Registered source name") })),
    querystring: toJsonSchema(
      z.object({
        scope: z
          .string()
          .optional()
          .describe("Platform scope to list within (defaults to the source's configured scope)"),
        limit: z.coerce.number().int().positive().max(500).optional().describe("Max traces (default 50)"),
        since: z.string().optional().describe("ISO-8601 lower time bound (best-effort)"),
      }),
    ),
    response: {
      200: {
        description: "Recent traces",
        ...toJsonSchema(z.object({ traces: z.array(TraceSummarySchema) })),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  inspect: {
    summary: "Inspect one trace (raw spans + normalized events)",
    description:
      "Pull a trace by id and return the events normalized with the SUPPLIED span-attribute mapping, plus (for " +
      "span-based kinds otel/mlflow) the raw span attributes so a mapping can be authored/iterated against real keys. " +
      "Native kinds (langfuse/langsmith/phoenix) ignore mapping and omit rawAttributes. Nothing is persisted. Read is " +
      "harnesses:read.",
    tags: ["trace-source"],
    params: toJsonSchema(
      z.object({ name: z.string().describe("Registered source name"), traceId: z.string().describe("Trace id") }),
    ),
    body: toJsonSchema(
      z.object({
        mapping: SpanAttrMappingSchema.optional().describe(
          "Span-attribute mapping to normalize with (span-based kinds)",
        ),
      }),
    ),
    response: {
      200: {
        description: "Raw attributes (span-based) + normalized events",
        ...toJsonSchema(TraceInspectResultSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  getMapping: {
    summary: "Get a harness's span-attribute mapping overlay",
    description:
      "The per-harness span-attribute mapping overlay — the mutable conversion layer between a harness and a judge. " +
      "null = no overlay set (the run-time resolver then uses the harness spec's mapping / defaults). Read is harnesses:read.",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (overlay is version-independent)") })),
    response: {
      200: {
        description: "The overlay (or null)",
        ...toJsonSchema(z.object({ mapping: SpanAttrMappingSchema.nullable() })),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  setMapping: {
    summary: "Set or clear a harness's span-attribute mapping overlay",
    description:
      "Store the per-harness conversion layer (authored in the judge wizard against a real trace) — applied at the " +
      "control-plane trace-collection seams, overriding the harness spec's mapping. mapping:null clears it. Requires " +
      "harnesses:register (member+ — part of the harness config).",
    tags: ["trace-source"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (overlay is version-independent)") })),
    body: toJsonSchema(
      z.object({ mapping: SpanAttrMappingSchema.nullable().describe("The mapping, or null to clear") }),
    ),
    response: {
      200: {
        description: "Updated overlay map (harness id → mapping)",
        ...toJsonSchema(z.object({ mappings: z.record(SpanAttrMappingSchema) })),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const traceSourceDocs: Record<keyof typeof docs, FastifySchema> = docs;
