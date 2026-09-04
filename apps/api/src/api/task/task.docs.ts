import { AgentTaskRecordSchema, AgentTaskStatusSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateTaskBodySchema } from "./request/create-task.js";
import { UpdateTaskBodySchema } from "./request/update-task.js";

// OpenAPI descriptors for the workspace task ledger (doc-only — never validates/serializes; see api/openapi.ts).
// shared, any member/agent creates/claims/completes (shared mutation IS the coordination), delete = creator or
// admin (decided in the service). Authz reuses the agent actions (no new action): read = agents:read, write =
// agents:write. Lifecycle facts task.created/claimed/completed/cancelled feed the event log; created/completed
export const taskDocs: Record<"create" | "list" | "get" | "update" | "delete", FastifySchema> = {
  create: {
    summary: "Create a task on the workspace ledger",
    description:
      "Add a unit of intended work to the workspace's shared task ledger. blockedBy chains it behind other " +
      "tasks (informational — readers decide ordering). Emits the trigger-matchable task.created fact; an " +
      "agent-created task stamps causedBy so the creator never wakes on its own task. Requires agents:write.",
    tags: ["task"],
    body: toJsonSchema(CreateTaskBodySchema),
    response: {
      201: { description: "The created task", ...toJsonSchema(AgentTaskRecordSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List the workspace's tasks",
    description:
      "The workspace's coordination tasks, newest activity first — optionally filtered by status. " +
      "Workspace-shared by design (no private tier). Requires agents:read.",
    tags: ["task"],
    querystring: toJsonSchema(
      z.object({
        status: AgentTaskStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Tasks, newest activity first", ...toJsonSchema(z.array(AgentTaskRecordSchema)) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Read one task",
    description: "One ledger task by id (another workspace's id reads 404). Requires agents:read.",
    tags: ["task"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The task", ...toJsonSchema(AgentTaskRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Update a task (claim / complete / edit)",
    description:
      "Patch a task. Any member/agent may update — shared mutation is the ledger's purpose. A status change " +
      "emits its fact (in_progress → task.claimed, recording the claimer as owner when unset; completed → " +
      "task.completed; cancelled → task.cancelled); a same-status patch emits nothing. Requires agents:write.",
    tags: ["task"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(UpdateTaskBodySchema),
    response: {
      200: { description: "The updated task", ...toJsonSchema(AgentTaskRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete a task",
    description: "Remove a ledger task — its creator or a workspace admin only. Requires agents:write.",
    tags: ["task"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 204: { description: "Deleted", type: "null" }, ...errorResponses(401, 403, 404) },
  },
};
