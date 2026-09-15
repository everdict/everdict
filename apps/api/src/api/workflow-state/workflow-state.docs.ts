import { WorkflowStateRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the workspace's board (doc-only — never validates/serializes; see api/openapi.ts).
// A workflow state is a COLUMN: the workspace's own name for a position in its workflow, declaring which
// canonical status it is a view onto. Authz: read = issues:read (viewer+, the same gate the tracker's content
// has). The board is read-only over HTTP.
export const workflowStateDocs: Record<"list", FastifySchema> = {
  list: {
    summary: "The workspace's workflow states",
    description:
      "The workspace's own names for the positions in its workflow, in board order. Each state declares the " +
      "CANONICAL status it is a view onto, so the release gate, the rollups and the regression watch read the " +
      "status whatever the column is called. A workspace with no board yet gets the default six here. " +
      "Requires issues:read.",
    tags: ["workflow-state"],
    response: {
      200: { description: "States in board order", ...toJsonSchema(z.array(WorkflowStateRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;
