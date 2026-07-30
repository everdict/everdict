import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { trajectoryDocs } from "./trajectory.docs.js";

// PUT body — mirrors WorkspaceSettings.traceThresholds (full replacement, like every settings list).
const TraceThresholdsBodySchema = z.object({
  thresholds: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        metric: z.enum(["usd", "total_tokens", "llm_calls", "tool_calls", "tool_failures", "events", "latency_ms_max"]),
        value: z.number().nonnegative(),
      }),
    )
    .max(50),
});

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

  // Trace thresholds (E4 perception config): evaluated over every trajectory at seal time — a crossing
  // lands trace.threshold_crossed on the log. Envelope-free settings CRUD (the secrets precedent).
  app.get("/workspace/trace-thresholds", { schema: trajectoryDocs.thresholdsGet }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace settings not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const settings = await deps.settingsStore.get(principal.workspace);
      return reply.send({ thresholds: settings?.traceThresholds ?? [] });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-thresholds", { schema: trajectoryDocs.thresholdsSet }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace settings not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      const parsed = TraceThresholdsBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      await deps.settingsStore.set(principal.workspace, { traceThresholds: parsed.data.thresholds });
      return reply.send({ thresholds: parsed.data.thresholds });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
