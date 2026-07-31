import { InitiativeRecordSchema, InitiativeStatusSchema } from "@everdict/contracts";
import { InitiativeDetailResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateInitiativeBodySchema } from "./request/create-initiative.js";
import { SetInitiativeStatusBodySchema } from "./request/set-initiative-status.js";
import { UpdateInitiativeBodySchema } from "./request/update-initiative.js";

// OpenAPI descriptors for the eval tracker's initiatives (doc-only — never validates/serializes; see
// api/openapi.ts). An initiative is the deployment umbrella: its readiness is the release verdict, and
// completing one is the gate that verdict enforces. Authz reuses the issue pair (read = issues:read,
// write = issues:write); delete additionally creator-or-admin. Facts initiative.created /
// initiative.status_changed feed the event log.
export const initiativeDocs: Record<"create" | "list" | "get" | "update" | "setStatus" | "delete", FastifySchema> = {
  create: {
    summary: "Create an initiative on the eval tracker",
    description:
      "The deployment umbrella over projects. It starts `active`; completion goes through " +
      "POST /initiatives/:id/status, which is the release gate. Emits initiative.created. Requires issues:write.",
    tags: ["initiative"],
    body: toJsonSchema(CreateInitiativeBodySchema),
    response: {
      201: { description: "The created initiative", ...toJsonSchema(InitiativeRecordSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List the workspace's initiatives",
    description:
      "The workspace's initiatives. Filter by status. Rows carry no readiness — that verdict is a fan-out over " +
      "every project's issues, served on the detail read. Requires issues:read.",
    tags: ["initiative"],
    querystring: toJsonSchema(
      z.object({
        status: InitiativeStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Initiatives", ...toJsonSchema(z.array(InitiativeRecordSchema)) },
      ...errorResponses(400, 401, 403),
    },
  },
  get: {
    summary: "Get an initiative with its release readiness",
    description:
      "One initiative plus the live readiness verdict: every project under it, their issue rollups, the open " +
      "count and the blocking issues. Open issues are counted across every non-cancelled project REGARDLESS of " +
      "that project's own status — a project marked completed whose issue later regressed still blocks the " +
      "release. Another workspace's id returns 404 (no existence leak). Requires issues:read.",
    tags: ["initiative"],
    response: {
      200: { description: "The initiative with its readiness", ...toJsonSchema(InitiativeDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit an initiative's content",
    description:
      "Name, description, target date. Status moves go through POST /initiatives/:id/status so the release gate " +
      "is never crossed by a rename; projects join from the project side (PATCH /projects/:id). null clears an " +
      "optional field. Requires issues:write.",
    tags: ["initiative"],
    body: toJsonSchema(UpdateInitiativeBodySchema),
    response: {
      200: { description: "The updated initiative", ...toJsonSchema(InitiativeRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setStatus: {
    summary: "Move an initiative through its lifecycle (completing is the release gate)",
    description:
      "active / completed / cancelled. Completing reads live readiness first and is refused with a 409 naming " +
      "the count while any issue under any of the initiative's projects is still open — the check a team wants " +
      "before shipping. Pass force:true to complete anyway; the override is stamped on the fact and the " +
      "history, so a forced release never later reads as a clean one. Requires issues:write.",
    tags: ["initiative"],
    body: toJsonSchema(SetInitiativeStatusBodySchema),
    response: {
      200: { description: "The moved initiative", ...toJsonSchema(InitiativeRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  delete: {
    summary: "Delete an initiative",
    description:
      "Hard delete, refused with a 409 while projects still sit under it (move them out first). Creator or " +
      "workspace admin only (enforced in the service). Requires issues:write.",
    tags: ["initiative"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404, 409) },
  },
};
