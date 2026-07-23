import { AgentSpecSchema } from "@everdict/contracts";
import {
  AgentListResponseSchema,
  AgentResponseSchema,
  DeleteAgentVersionResultSchema,
  DeleteAgentVersionsResultSchema,
  RegisterAgentResultSchema,
  SaveAgentResultSchema,
  ValidateAgentResultSchema,
} from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { DeleteAgentVersionsBodySchema } from "./request/delete-agent-versions.js";
import { SaveAgentBodySchema } from "./request/save-agent.js";

// OpenAPI descriptors for the agent routes — doc-only (rule api-layer): the no-op compilers in server.ts make
// attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Agent id" },
    version: { type: "string", description: 'Agent version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register an agent version",
    description:
      "Registers a workspace-owned agent configuration (instructions + MCP tool servers + model) that customizes the " +
      "conversational agent for this workspace. Requires agents:write (member+). Versions are immutable — re-registering " +
      "the same (id, version) with different content is 409. Reads resolve workspace-owned first with a _shared fallback.",
    tags: ["agent"],
    body: toJsonSchema(AgentSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterAgentResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate an agent spec",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, plus " +
      "any referenced mcpServers[].authSecret name not yet set in this workspace's SecretStore (warning), without " +
      "registering. Requires agents:write (member+). Validation failures are reported as ok:false in a 200 response.",
    tags: ["agent"],
    body: toJsonSchema(AgentSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateAgentResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  save: {
    summary: "Save (upsert) an agent configuration",
    description:
      "The interactive edit path: a new id registers version 1.0.0; a changed spec auto patch-bumps to a NEW immutable " +
      "version (so `latest` moves while past-pinned conversations stay reproducible); an unchanged spec is an idempotent " +
      "no-op (created:false). The id is the path param and the version is assigned server-side, so neither is in the " +
      "body. Requires agents:write (member+). POST /agents remains the explicit-version programmatic path.",
    tags: ["agent"],
    params: { type: "object", properties: { id: { type: "string", description: "Agent id" } }, required: ["id"] },
    body: toJsonSchema(SaveAgentBodySchema),
    response: {
      200: { description: "Saved (created:true) or unchanged (created:false)", ...toJsonSchema(SaveAgentResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  list: {
    summary: "List agents",
    description:
      "Lists this workspace's agent configurations plus _shared first-party entries (workspace-owned first, _shared " +
      "fallback). Requires agents:read (viewer+).",
    tags: ["agent"],
    response: {
      200: { description: "Agent list entries", ...toJsonSchema(AgentListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get an agent version",
    description:
      'The full AgentSpec for one version. version may be "latest" (semver-latest). Requires agents:read (viewer+). ' +
      "Another workspace's agent reads 404 — no existence leak.",
    tags: ["agent"],
    params: idVersionParams,
    response: {
      200: { description: "AgentSpec", ...toJsonSchema(AgentResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  deleteVersion: {
    summary: "Soft-delete an agent version",
    description:
      "Tombstones one agent version (data preserved, excluded from reads). Allowed for that version's creator or a " +
      "workspace admin (agents:delete) — enforced in the service. Missing/already-deleted/non-owned versions are 404.",
    tags: ["agent"],
    params: idVersionParams,
    response: {
      200: { description: "Deleted (tombstoned)", ...toJsonSchema(DeleteAgentVersionResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  deleteVersions: {
    summary: "Soft-delete several agent versions or the whole agent",
    description:
      "Bulk tombstone — pass `versions` to delete specific versions, or omit the body to delete the whole agent (all of " +
      "its own live versions). Every target is checked creator-or-admin (agents:delete) BEFORE any delete, so a single " +
      "forbidden/absent version rejects the whole request (403/404) with nothing deleted. An unknown / already-fully-" +
      "deleted agent is 404.",
    tags: ["agent"],
    params: { type: "object", properties: { id: { type: "string", description: "Agent id" } }, required: ["id"] },
    body: toJsonSchema(DeleteAgentVersionsBodySchema),
    response: {
      200: { description: "Deleted (tombstoned) versions", ...toJsonSchema(DeleteAgentVersionsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): keeps the doc attachment behavior-free (no reply.code() narrowing).
export const agentDocs: Record<keyof typeof docs, FastifySchema> = docs;
