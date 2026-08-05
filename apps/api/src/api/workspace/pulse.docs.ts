import { WorkspacePulseSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptor for the workspace pulse (doc-only — never validates/serializes; see api/openapi.ts).
export const pulseDocs: Record<"read", FastifySchema> = {
  read: {
    summary: "Read the workspace pulse",
    description:
      "How the workspace is doing, in one read: the state right now (open issues, active cycles, goals at risk, " +
      "unfinished agent tasks, pending approvals) plus the trend over the last `days` days (recorded activity by " +
      "axis, issue flow in/out, evaluated pass rate). The trend is derived from the platform-event log, so it " +
      "says what the log holds and stops at the deployment's retention edge. Counts are scoped to the teams the " +
      "caller may read — a private team's work is not in them. Requires issues:read.",
    tags: ["workspace"],
    querystring: toJsonSchema(
      z.object({
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("trend window in days, today included (default 30)"),
      }),
    ),
    response: {
      200: { description: "The workspace pulse", ...toJsonSchema(WorkspacePulseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
};
