import { IssueLabelColorSchema, IssueLabelRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the eval tracker's LABEL REGISTRY (doc-only — never validates/serializes; see
// api/openapi.ts). A label is a workspace-level record an issue points at by id, which is what lets a rename or
// a recolour be one write every issue sees. Authz reuses the tracker's action pair (issues:read / issues:write).
// Facts issue_label.created / .updated / .deleted feed the event log.

const CreateBodySchema = z.object({
  name: z.string().min(1).max(64),
  color: IssueLabelColorSchema,
  description: z.string().max(500).optional(),
});

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: IssueLabelColorSchema.optional(),
  description: z.string().max(500).nullable().optional(),
});

const UsageResponseSchema = z.object({
  issues: z.number().int().nonnegative().describe("How many issues currently wear this label"),
});

const idParam = {
  type: "object",
  properties: { id: { type: "string", description: "Label id" } },
  required: ["id"],
} as const;

export const issueLabelDocs: Record<"list" | "create" | "update" | "remove" | "usage", FastifySchema> = {
  list: {
    summary: "List the workspace's issue labels",
    description:
      "The classification vocabulary an issue's labelIds point at, name-ascending. A client renders a chip by " +
      "joining this list against the issue — the same join it already does for members and projects. " +
      "Requires issues:read.",
    tags: ["issue"],
    response: {
      200: { description: "Every label in the workspace", ...toJsonSchema(z.array(IssueLabelRecordSchema)) },
      ...errorResponses(401, 403),
    },
  },
  create: {
    summary: "Define an issue label",
    description:
      "Names are unique per workspace, compared case-insensitively — a clash is 409. Colour comes from the " +
      "closed vocabulary (gray|purple|blue|teal|green|yellow|orange|red|pink) so a label stays legible in both " +
      "themes. Emits issue_label.created. Requires issues:write.",
    tags: ["issue"],
    body: toJsonSchema(CreateBodySchema),
    response: {
      201: { description: "The defined label", ...toJsonSchema(IssueLabelRecordSchema) },
      ...errorResponses(400, 401, 403, 409),
    },
  },
  update: {
    summary: "Rename or recolour an issue label",
    description:
      "One write that every issue wearing the label sees at once — the property the old free-string labels " +
      "could never have. `description: null` clears it. A name clash is 409. Emits issue_label.updated. " +
      "Requires issues:write.",
    tags: ["issue"],
    params: idParam,
    body: toJsonSchema(UpdateBodySchema),
    response: {
      200: { description: "The updated label", ...toJsonSchema(IssueLabelRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  remove: {
    summary: "Delete an issue label",
    description:
      "Deletes the label AND strips its id from every issue that wears it, in one transaction — labelIds can " +
      "never point at a label that is gone. Call GET /issue-labels/:id/usage first to warn. Emits " +
      "issue_label.deleted. Requires issues:write.",
    tags: ["issue"],
    params: idParam,
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404) },
  },
  usage: {
    summary: "How many issues wear this label",
    description: "The count a delete confirmation shows before the label is stripped off them. Requires issues:read.",
    tags: ["issue"],
    params: idParam,
    response: {
      200: { description: "Usage count", ...toJsonSchema(UsageResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
};
