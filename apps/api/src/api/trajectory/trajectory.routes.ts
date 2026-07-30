import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { trajectoryDocs } from "./trajectory.docs.js";

// The owned trajectory ledger (N1): a browse LIST over the sealed evidence. Envelope-free trivial read —
// the route calls the store directly (the secrets-list precedent); detail reads stay on the run surface.
export function registerTrajectoryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/trajectories",
    { schema: trajectoryDocs.list },
    async (req, reply) => {
      if (!deps.trajectoryStore)
        return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const limit = req.query.limit !== undefined ? Number.parseInt(req.query.limit, 10) : undefined;
        return reply.send(
          await deps.trajectoryStore.list(principal.workspace, {
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            ...(req.query.cursor !== undefined && req.query.cursor !== "" ? { cursor: req.query.cursor } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
