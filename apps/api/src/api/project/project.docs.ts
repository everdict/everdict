import { ProjectRecordSchema, ProjectStatusSchema } from "@everdict/contracts";
import { ProjectDetailResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateProjectBodySchema } from "./request/create-project.js";
import { SetProjectStatusBodySchema } from "./request/set-project-status.js";
import { UpdateProjectBodySchema } from "./request/update-project.js";

// OpenAPI descriptors for the eval tracker's projects (doc-only — never validates/serializes; see api/openapi.ts).
// A project groups issues under one target date, and completing it is the smaller sibling of the initiative's
// release gate: refused while issues are open, overridable with force, recorded either way. Authz reuses the
// issue pair (read = issues:read, write = issues:write); delete additionally creator-or-admin. Facts
// project.created / project.status_changed feed the event log.
export const projectDocs: Record<"create" | "list" | "get" | "update" | "setStatus" | "delete", FastifySchema> = {
  create: {
    summary: "Create a project on the eval tracker",
    description:
      "Group issues under one target date, optionally beneath an initiative. The project starts `planned`; " +
      "moves go through POST /projects/:id/status. Emits project.created. Requires issues:write.",
    tags: ["project"],
    body: toJsonSchema(CreateProjectBodySchema),
    response: {
      201: { description: "The created project", ...toJsonSchema(ProjectRecordSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List the workspace's projects",
    description:
      "The workspace's projects. Filter by status or by the initiative they sit under. Rows carry no rollup — " +
      "read one project for its issue counts. Requires issues:read.",
    tags: ["project"],
    querystring: toJsonSchema(
      z.object({
        status: ProjectStatusSchema.optional(),
        initiative: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Projects", ...toJsonSchema(z.array(ProjectRecordSchema)) },
      ...errorResponses(400, 401, 403),
    },
  },
  get: {
    summary: "Get a project with its issue rollup",
    description:
      "One project plus the live rollup of its issues (total / open / done / cancelled / evaluated, and whether " +
      "it is ready to complete). The rollup is derived per read, never stored. Another workspace's id returns " +
      "404 (no existence leak). Requires issues:read.",
    tags: ["project"],
    response: {
      200: { description: "The project with its rollup", ...toJsonSchema(ProjectDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit a project's content",
    description:
      "Name, description, owning initiative, target date. Status moves go through POST /projects/:id/status so " +
      "a completion is never a side effect of a rename. null clears an optional field. Requires issues:write.",
    tags: ["project"],
    body: toJsonSchema(UpdateProjectBodySchema),
    response: {
      200: { description: "The updated project", ...toJsonSchema(ProjectRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setStatus: {
    summary: "Move a project through its lifecycle",
    description:
      "planned / in_progress / completed / cancelled. Completing is a gate: it is refused with a 409 naming the " +
      "count while any of the project's issues are still open. Pass force:true to complete anyway — the " +
      "override is stamped on the fact and the history, so a forced completion never later reads as a met " +
      "deadline. Requires issues:write.",
    tags: ["project"],
    body: toJsonSchema(SetProjectStatusBodySchema),
    response: {
      200: { description: "The moved project", ...toJsonSchema(ProjectRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  delete: {
    summary: "Delete a project",
    description:
      "Hard delete, refused with a 409 while the project still holds issues (deleting would orphan them — move " +
      "them first). Creator or workspace admin only (enforced in the service). Requires issues:write.",
    tags: ["project"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404, 409) },
  },
};
