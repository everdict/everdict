import { ViewListResponseSchema } from "@everdict/contracts/wire";
import { ViewResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateViewBodySchema } from "./request/create-view.js";
import { UpdateViewBodySchema } from "./request/update-view.js";

// OpenAPI descriptors for the saved scorecard-analysis View routes (doc-only — never validates/serializes;
// see api/openapi.ts). A View is a named, opaque AnalysisConfig re-run live when opened — not a snapshot.
// Authz reuses the scorecard actions (no new action): read = scorecards:read, write = scorecards:run;
// edit/delete additionally require creator-or-admin (decided in the service).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const viewDocs: Record<"create" | "list" | "get" | "update" | "delete", FastifySchema> = {
  create: {
    summary: "Save an analysis view",
    description:
      "Requires scorecards:run. config is opaque to the control plane (the web validates its shape). " +
      "visibility: private (only the creator sees it) or workspace (shared); defaults to private.",
    tags: ["view"],
    body: toJsonSchema(CreateViewBodySchema),
    response: {
      201: { description: "Created view", ...toJsonSchema(ViewResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List visible views",
    description:
      "Workspace-shared views plus the caller's own private ones (other members' private views are never listed). Requires scorecards:read.",
    tags: ["view"],
    response: {
      200: { description: "Visible views", ...toJsonSchema(ViewListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a view",
    description:
      "Requires scorecards:read. Someone else's private view, a foreign workspace's view, or an unknown id all read 404 (no existence leak).",
    tags: ["view"],
    params: toJsonSchema(z.object({ id: z.string().describe("View id") })),
    response: {
      200: { description: "View record", ...toJsonSchema(ViewResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Update a view",
    description:
      "Requires scorecards:run, and editing is creator-or-admin (decided in the service — others get 403). " +
      "Partial patch of name/config/visibility. Unknown or foreign id = 404.",
    tags: ["view"],
    params: toJsonSchema(z.object({ id: z.string().describe("View id") })),
    body: toJsonSchema(UpdateViewBodySchema),
    response: {
      200: { description: "Updated view record", ...toJsonSchema(ViewResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete a view",
    description:
      "Requires scorecards:run, and deleting is creator-or-admin (decided in the service — others get 403). Unknown or foreign id = 404.",
    tags: ["view"],
    params: toJsonSchema(z.object({ id: z.string().describe("View id") })),
    response: {
      204: { description: "Deleted (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
};
