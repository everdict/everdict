import { CycleProgressSchema, CycleRecordSchema, CycleStateSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CompleteCycleBodySchema, CreateCycleBodySchema, UpdateCycleBodySchema } from "./request/create-cycle.js";

// OpenAPI descriptors for a team's iterations (doc-only — never validates/serializes; see api/openapi.ts).
// AuthZ: read = issues:read (viewer+), write = issues:write (member+); delete additionally creator-or-admin.
// Facts cycle.created / cycle.completed feed the event log; the latter is trigger-matchable and carries
// `carriedOver`, which is the number a retro asks for.
const CycleDetailSchema = CycleRecordSchema.extend({ state: CycleStateSchema, progress: CycleProgressSchema });

export const cycleDocs: Record<"create" | "list" | "get" | "update" | "complete" | "delete", FastifySchema> = {
  create: {
    summary: "Plan a team's next iteration",
    description:
      "Create a cycle for a team. Omit both dates to take the window proposed from the team's cadence (the day " +
      "after its latest cycle ends, for cycleDurationWeeks) — pass both to name your own; one alone is a 400. " +
      "The number comes from the team's own sequence, so `Cycle 7` means the seventh iteration THAT team ran. " +
      "Requires issues:write.",
    tags: ["cycle"],
    body: toJsonSchema(CreateCycleBodySchema),
    response: {
      201: { description: "The planned cycle", ...toJsonSchema(CycleRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List cycles",
    description:
      "A workspace's cycles, newest iteration first. Filter by team, or by `open=true` for the ones nobody has " +
      "closed — 'open' is the absence of an explicit close, never a passed end date, so a cycle somebody forgot " +
      "to close still shows up. Rows carry no progress: that fans out over the cycle's issues, so call " +
      "GET /cycles/:id. Requires issues:read.",
    tags: ["cycle"],
    querystring: toJsonSchema(
      z.object({
        team: z.string().optional(),
        open: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    ),
    response: {
      200: { description: "Cycles, newest first", ...toJsonSchema(z.array(CycleRecordSchema)) },
      ...errorResponses(400, 401, 403),
    },
  },
  get: {
    summary: "Get a cycle with its progress",
    description:
      "One cycle plus its derived state (upcoming | active | completed) and what it holds: issue counts and " +
      "POINTS (`scope` / `completedScope` from the estimates). The counts count issues and the points count " +
      "estimates — an unestimated issue is real work worth zero points, and counting it as one would inflate " +
      "every burn-down. Requires issues:read.",
    tags: ["cycle"],
    response: {
      200: { description: "The cycle, its state and its progress", ...toJsonSchema(CycleDetailSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit a cycle",
    description:
      "Rename, re-describe or move the window. A CLOSED cycle refuses every edit (409) — a finished iteration " +
      "is a record, not a plan. Requires issues:write.",
    tags: ["cycle"],
    body: toJsonSchema(UpdateCycleBodySchema),
    response: {
      200: { description: "The updated cycle", ...toJsonSchema(CycleRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  complete: {
    summary: "Close an iteration",
    description:
      "Close the cycle and, with `moveUnfinishedTo`, carry everything still open into another OPEN cycle of the " +
      "SAME team in the same operation. Unlike completing a project this is NOT a gate: an iteration ending " +
      "with unfinished work is the normal case, and the fact records how many were carried over. Requires " +
      "issues:write.",
    tags: ["cycle"],
    body: toJsonSchema(CompleteCycleBodySchema),
    response: {
      200: { description: "The closed cycle", ...toJsonSchema(CycleRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  delete: {
    summary: "Delete a cycle",
    description:
      "Creator or workspace admin only (enforced in the service). A cycle that still holds issues refuses with " +
      "a 409 — move them to another iteration first. Requires issues:write.",
    tags: ["cycle"],
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404, 409) },
  },
};
