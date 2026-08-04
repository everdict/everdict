import { InitiativeRecordSchema, InitiativeStatusSchema, InitiativeUpdateRecordSchema } from "@everdict/contracts";
import { InitiativeDetailResponseSchema, InitiativeListItemSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateInitiativeBodySchema } from "./request/create-initiative.js";
import { PostInitiativeUpdateBodySchema } from "./request/post-initiative-update.js";
import { SetInitiativeStatusBodySchema } from "./request/set-initiative-status.js";
import { UpdateInitiativeBodySchema } from "./request/update-initiative.js";

// OpenAPI descriptors for the eval tracker's initiatives (doc-only — never validates/serializes; see
// api/openapi.ts). An initiative is a GOAL several projects work toward: its progress is arithmetic over every
// issue underneath, its health is what the lead reports on top of that, and completing it is a gate because a
// goal with open work under it has not been reached. Authz reuses the issue pair (read = issues:read,
// write = issues:write); delete additionally creator-or-admin. Facts initiative.created /
// initiative.status_changed / initiative.update_posted feed the event log.
export const initiativeDocs: Record<
  "create" | "list" | "get" | "update" | "postUpdate" | "listUpdates" | "setStatus" | "delete",
  FastifySchema
> = {
  create: {
    summary: "Create an initiative on the eval tracker",
    description:
      "A goal several projects work toward. It starts `planned` — moving it to `active` is the moment work " +
      "under it begins, and both that and completion go through POST /initiatives/:id/status (completion " +
      "refuses while work underneath is open). Emits initiative.created. Requires issues:write.",
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
      "The workspace's initiatives. Filter by status. Each row carries the reported health AND its progress " +
      "(open / total issues, project count) — the same three numbers the detail derives, computed from one " +
      "aggregate rather than a fan-out per row. Naming what is still open stays the detail's job. " +
      "Requires issues:read.",
    tags: ["initiative"],
    querystring: toJsonSchema(
      z.object({
        status: InitiativeStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Initiatives with their progress", ...toJsonSchema(z.array(InitiativeListItemSchema)) },
      ...errorResponses(400, 401, 403),
    },
  },
  get: {
    summary: "Get an initiative with its live progress",
    description:
      "One initiative plus how far along it is: every project under it (with that project's status, reported " +
      "health and lead), their issue rollups, the open count and the issues still to finish. Open issues are " +
      "counted across every non-cancelled project REGARDLESS of that project's own status — a project marked " +
      "completed whose issue later regressed is still unfinished work under the goal. Another workspace's id " +
      "returns 404 (no existence leak). Requires issues:read.",
    tags: ["initiative"],
    response: {
      200: { description: "The initiative with its progress", ...toJsonSchema(InitiativeDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit an initiative's content",
    description:
      "Name, description, lead, members, icon, resources, target date, parent. Status moves go through POST /initiatives/:id/status so " +
      "the completion gate is never crossed by a rename; projects join from the project side " +
      "(PATCH /projects/:id). null clears an optional field. Requires issues:write.",
    tags: ["initiative"],
    body: toJsonSchema(UpdateInitiativeBodySchema),
    response: {
      200: { description: "The updated initiative", ...toJsonSchema(InitiativeRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  postUpdate: {
    summary: "Post an initiative update",
    description:
      "Where the goal stands, in the words of the person answerable for it: `health` (on_track | at_risk | " +
      "off_track) WITH the sentence that explains it — the body is required, because a health flag with no " +
      "sentence is a colour nobody can explain. The initiative keeps the latest health so a list row shows it " +
      "without reading the timeline. Emits the trigger-matchable initiative.update_posted fact, so 'wake me " +
      "when this goal slips' is a payload filter. Requires issues:write.",
    tags: ["initiative"],
    body: toJsonSchema(PostInitiativeUpdateBodySchema),
    response: {
      201: { description: "The posted update", ...toJsonSchema(InitiativeUpdateRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  listUpdates: {
    summary: "The initiative's update timeline",
    description: "Posted updates, newest first (capped). Requires issues:read.",
    tags: ["initiative"],
    response: {
      200: { description: "Updates, newest first", ...toJsonSchema(z.array(InitiativeUpdateRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  setStatus: {
    summary: "Move an initiative through its lifecycle (completing is a gate)",
    description:
      "planned / active / completed / cancelled. Completing reads live progress first and is refused with a 409 naming " +
      "the count while any issue under any of the initiative's projects is still open — a goal with unfinished " +
      "work under it has not been reached. Pass force:true to complete anyway; the override is stamped on the " +
      "fact and the history, so a forced completion never later reads as a clean one. Requires issues:write.",
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
