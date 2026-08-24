import type { FastifyInstance } from "fastify";
import { type ServerDeps, constantTimeEq, gate, resolvePrincipal, sendError } from "../route-context.js";
import { queueDocs } from "./queue.docs.js";

// workload visibility — Prometheus text metrics (operator-token scrape) + the work-queue snapshot per runtime lane (viewer+).
export function registerQueueRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- work queue (workload visibility) — snapshot of running/waiting (FIFO)/next-scheduled fire per runtime lane. viewer+ read-only. ---
  // Prometheus scrape — OPERATOR-ONLY, fail-closed like /internal/** (the internal-token precedent): the
  // exposition carries per-workspace labels (everdict_tenant_*{workspace=…}), so an open scrape leaks every
  // tenant's existence and activity volume to anyone who can reach the port. No token configured → the
  // scrape does not exist (404); Prometheus authenticates with one scrape-config line (`bearer_token`).
  app.get("/metrics", { schema: queueDocs.metrics }, async (req, reply) => {
    if (!deps.metrics || !deps.metricsToken)
      return reply.code(404).send({ code: "NOT_FOUND", message: "metrics not configured" });
    const auth = req.headers.authorization;
    const provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    if (provided === undefined || !constantTimeEq(provided, deps.metricsToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "metrics token mismatch" });
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(deps.metrics.render());
  });

  app.get("/queue", { schema: queueDocs.queue }, async (req, reply) => {
    if (!deps.queueService) return reply.code(404).send({ code: "NOT_FOUND", message: "queue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      // The requester subject is needed to scope the personal queue (my self-hosted runners).
      return reply.send(await deps.queueService.snapshot(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Cancel ONE waiting scheduler entry (scheduler.entries id) — the queue page's kill switch. Same gate as
  // submitting work (runs:submit); another workspace's / an already-placed entry is 404 (no existence leak).
  app.delete<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId",
    { schema: queueDocs.cancelEntry },
    async (req, reply) => {
      if (!deps.queueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "queue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:submit");
        return reply.send(deps.queueService.cancelSchedulerEntry(principal.workspace, req.params.entryId));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Move ONE waiting scheduler entry to the front of the effective order — "run this next" (queue reordering).
  app.post<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId/promote",
    { schema: queueDocs.promoteEntry },
    async (req, reply) => {
      if (!deps.queueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "queue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:submit");
        return reply.send(deps.queueService.promoteSchedulerEntry(principal.workspace, req.params.entryId));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
