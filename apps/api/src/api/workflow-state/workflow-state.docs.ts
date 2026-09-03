import { WorkflowStateRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateWorkflowStateBodySchema, UpdateWorkflowStateBodySchema } from "./request/workflow-state.js";

// OpenAPI descriptors for the workspace's board (doc-only — never validates/serializes; see api/openapi.ts).
// A workflow state is a COLUMN: the workspace's own name for a position in its workflow, declaring which
// canonical status it is a view onto. Authz: read = issues:read (viewer+, the same gate the tracker's content
// has), write = settings:write (admin) — shaping the board is workspace administration, not tracker content.
export const workflowStateDocs: Record<"list" | "create" | "update" | "delete", FastifySchema> = {
  list: {
    summary: "The workspace's workflow states",
    description:
      "The workspace's own names for the positions in its workflow, in board order. Each state declares the " +
      "CANONICAL status it is a view onto — which is what lets a column be renamed, recoloured, reordered or " +
      "added without any of it reaching the release gate, the rollups or the regression watch. A workspace " +
      "with no board yet gets the default six here. Requires issues:read.",
    tags: ["workflow-state"],
    response: {
      200: { description: "States in board order", ...toJsonSchema(z.array(WorkflowStateRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  create: {
    summary: "Add a workflow state",
    description:
      "A new column at the end of the board, declaring which canonical status it is. `regressed` is refused: " +
      "an issue reaches it by a resolution falling, never by somebody dragging a card. A duplicate name is a " +
      "409. Requires settings:write.",
    tags: ["workflow-state"],
    body: toJsonSchema(CreateWorkflowStateBodySchema),
    response: {
      201: { description: "The new state", ...toJsonSchema(WorkflowStateRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  update: {
    summary: "Rename, recolour, reorder or re-map a state",
    description:
      "Renaming and recolouring are cosmetic; changing `position` reorders the board; changing `status` " +
      "RE-MAPS the column, which moves every issue in it to that canonical status in the same operation — the " +
      "board and the record can never disagree. Requires settings:write.",
    tags: ["workflow-state"],
    body: toJsonSchema(UpdateWorkflowStateBodySchema),
    response: {
      200: { description: "The updated state", ...toJsonSchema(WorkflowStateRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  delete: {
    summary: "Remove a workflow state",
    description:
      "Removes a column from the board. The issues in it are not deleted — they keep the canonical status the " +
      "column mapped to, which is what the rollups and the release gate have always read. Requires " +
      "settings:write.",
    tags: ["workflow-state"],
    response: { 204: { description: "Removed" }, ...errorResponses(401, 403, 404, 409) },
  },
} satisfies Record<string, FastifySchema>;
