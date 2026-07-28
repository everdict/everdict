import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the platform-event log read surface (documentation only — no-op compilers).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const eventDocs: Record<"list", FastifySchema> = {
  list: {
    summary: "List the workspace's platform events",
    description:
      "The recorded lifecycle FACTS of this workspace (docs/architecture/agent-automation.md A1) — " +
      "run/scorecard/comment/agent-run events, newest first by default. Powers the fleet's event feed and the " +
      "agent crafting studio's replay picker (fire a real past event at a draft agent). Read-only; events are " +
      "emitted by the system. Gate: events:read (viewer+).",
    tags: ["events"],
    querystring: toJsonSchema(
      z.object({
        after: z.coerce.number().int().nonnegative().optional().describe("only events with seq > after"),
        kinds: z.string().optional().describe("comma-separated kind filter"),
        limit: z.coerce.number().int().positive().max(200).optional().describe("default 50"),
        order: z.enum(["asc", "desc"]).optional().describe("default desc (newest first)"),
      }),
    ),
    response: {
      200: { description: "Events" },
      ...errorResponses(400, 401, 403, 404),
    },
  },
};
