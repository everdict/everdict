import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { eventDocs } from "./event.docs.js";

// Platform-event log (docs/architecture/agent-automation.md A1) — the workspace's recorded lifecycle FACTS.
// Read-only observability: the fleet's event feed + the crafting studio's replay picker (fire a REAL past event
// at a draft agent). Events are emitted by the system, never written through this surface.
export function registerEventRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/events", { schema: eventDocs.list }, async (req, reply) => {
    if (!deps.platformEvents)
      return reply.code(404).send({ code: "NOT_FOUND", message: "platform events not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "events:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().optional(),
        kinds: z.string().optional(), // comma-separated kind filter
        limit: z.coerce.number().int().positive().max(200).optional(),
        order: z.enum(["asc", "desc"]).optional(), // default desc — the human surfaces read newest-first
      })
      .safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { after, kinds, limit, order } = query.data;
    const events = await deps.platformEvents.list(principal.workspace, {
      ...(after !== undefined ? { afterSeq: after } : {}),
      ...(kinds !== undefined ? { kinds: kinds.split(",").filter((k) => k.length > 0) } : {}),
      limit: limit ?? 50,
      order: order ?? "desc",
    });
    return reply.send({ events });
  });
}
