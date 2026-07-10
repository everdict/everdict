import { ScheduleListResponseSchema } from "@everdict/contracts/wire";
import { ScheduleResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateScheduleBodySchema } from "./request/create-schedule.js";
import { UpdateScheduleBodySchema } from "./request/update-schedule.js";

const scheduleIdParams = toJsonSchema(z.object({ id: z.string().describe("Schedule id") }));

// OpenAPI descriptors for the schedule routes (scheduled cron scorecards) — documentation only
// (no-op compilers; rule api-layer). Attached by schedule.routes.ts as { schema: scheduleDocs.<key> }.
const docs = {
  create: {
    summary: "Create a schedule",
    description:
      "Creates a scheduled (cron) scorecard: a stored run template + 5-field cron expression + overlap policy. " +
      "Workspace-scoped; requires schedules:write (member+). The fired run's submittedBy is the creator " +
      "(budget attribution + private-repo connection resolution). Firing is driven by a Temporal Schedule.",
    tags: ["schedule"],
    body: toJsonSchema(CreateScheduleBodySchema),
    response: {
      201: { description: "Schedule created", ...toJsonSchema(ScheduleResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List schedules",
    description:
      "Lists the workspace's schedules with best-effort Temporal next fire times. Requires schedules:read " +
      "(viewer+).",
    tags: ["schedule"],
    response: {
      200: { description: "Schedule records", ...toJsonSchema(ScheduleListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a schedule",
    description:
      "Reads one schedule, workspace-scoped (another workspace's schedule reads 404 — no existence leak). " +
      "Requires schedules:read (viewer+).",
    tags: ["schedule"],
    params: scheduleIdParams,
    response: {
      200: { description: "The schedule record", ...toJsonSchema(ScheduleResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Update a schedule",
    description:
      "Partial update (cron/template edits, enabled pause/resume). Requires schedules:write (member+), " +
      "workspace-scoped. Content edits are restricted to the creator or an admin (403 otherwise); the Temporal " +
      "Schedule is re-synced idempotently.",
    tags: ["schedule"],
    params: scheduleIdParams,
    body: toJsonSchema(UpdateScheduleBodySchema),
    response: {
      200: { description: "The updated schedule record", ...toJsonSchema(ScheduleResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Delete a schedule",
    description:
      "Deletes a schedule (and removes its Temporal Schedule). Requires schedules:write (member+), " +
      "workspace-scoped (404 when not found).",
    tags: ["schedule"],
    params: scheduleIdParams,
    response: {
      204: { description: "Deleted (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const scheduleDocs: Record<keyof typeof docs, FastifySchema> = docs;
