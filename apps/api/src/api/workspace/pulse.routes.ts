import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { pulseDocs } from "./pulse.docs.js";

// The default trend window. A month is long enough that a weekly rhythm is visible and short enough that the
// log's retention almost always covers it.
export const DEFAULT_PULSE_DAYS = 30;

export const PulseQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

// GET /workspace/pulse — the home screen's one read (docs/architecture/workspace-pulse.md).
//
// One gate for a read that spans five domains: every action it composes (issues/scorecards/events/agents) is
// viewer+, so gating each one separately would ask the same question five times and get the same answer. It is
// stated as `issues:read` because the tracker is the largest half of what comes back — the Views precedent
// (reuse the action the data belongs to, never invent one for a new screen).
export function registerWorkspacePulseRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/workspace/pulse", { schema: pulseDocs.read }, async (req, reply) => {
    if (!deps.workspacePulseService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace pulse not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const query = PulseQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      gate(principal, "issues:read");
      return reply.send(
        await deps.workspacePulseService.read({
          tenant: principal.workspace,
          days: query.data.days ?? DEFAULT_PULSE_DAYS,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
