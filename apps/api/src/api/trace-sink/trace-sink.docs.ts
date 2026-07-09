import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { TraceSinkAssignmentsResponseSchema } from "./response/trace-sink-assignments.js";
import { TraceSinkUpsertResponseSchema } from "./response/trace-sink-config-view.js";
import { TraceSinkRosterSchema } from "./response/trace-sink-roster.js";

// Doc-only OpenAPI descriptors for workspace trace sinks — export judged scorecard detail to the team's
// observability platform (rule api-layer: schemas document, never validate/serialize — the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  list: {
    summary: "List workspace trace sinks",
    description:
      "Registered sinks (MLflow/Langfuse/LangSmith/Phoenix) plus the per-harness selection map. Export is " +
      "opt-in: a harness with no selection is never exported. Read is harnesses:read (viewer+ — the view is " +
      "name references/URLs only, no secret values). Design: docs/architecture/trace-sink.md.",
    tags: ["trace-sink"],
    response: {
      200: { description: "Sink roster + per-harness assignments", ...toJsonSchema(TraceSinkRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  upsert: {
    summary: "Register or update a trace sink",
    description:
      "Name-keyed upsert (declarative full replace). Put the auth token value into the SecretStore first and " +
      "pass only its name. Requires settings:write (admin) — sink selection per harness is the separate " +
      "member-gated route.",
    tags: ["trace-sink"],
    body: toJsonSchema(
      z.object({
        name: z.string().min(1).describe("Sink name (reference key)"),
        kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url().describe("Platform API base URL"),
        authSecretName: z.string().min(1).optional().describe("SecretStore name of the auth-header value"),
        project: z.string().min(1).optional(),
        webUrl: z.string().url().optional().describe("UI deep-link base when it differs from the API endpoint"),
      }),
    ),
    response: {
      200: { description: "Stored sink", ...toJsonSchema(TraceSinkUpsertResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Remove a trace sink",
    description:
      "Removes the named sink and cleans up any per-harness selections that pointed at it (no dangling " +
      "references). Requires settings:write (admin).",
    tags: ["trace-sink"],
    params: toJsonSchema(z.object({ name: z.string().describe("Sink name") })),
    response: { 204: { description: "Removed", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  assign: {
    summary: "Select a trace sink for a harness",
    description:
      "Per-harness opt-in: chooses which sink this harness's judged scorecards export to. sink:null clears the " +
      "selection (export off); an unregistered sink name is 400. Requires harnesses:register (member+ — part of " +
      "the harness config, unlike the admin-gated sink registration).",
    tags: ["trace-sink"],
    params: toJsonSchema(z.object({ id: z.string().describe("Harness id (selection is version-independent)") })),
    body: toJsonSchema(
      z.object({ sink: z.string().min(1).nullable().describe("Sink name, or null to deselect (export off)") }),
    ),
    response: {
      200: { description: "Updated per-harness selection map", ...toJsonSchema(TraceSinkAssignmentsResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const traceSinkDocs: Record<keyof typeof docs, FastifySchema> = docs;
