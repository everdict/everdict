import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// workload visibility — Prometheus text metrics (unauthenticated scrape) + the work-queue snapshot per runtime lane (viewer+).
export function registerQueueRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- work queue (workload visibility) — snapshot of running/waiting (FIFO)/next-scheduled fire per runtime lane. viewer+ read-only. ---
  // Prometheus scrape — UNAUTHENTICATED by design (standard practice; the scrape path is expected to be
  // firewalled). Counters/histograms accumulate at the dispatch seam; gauges sample live components.
  app.get("/metrics", async (_req, reply) => {
    if (!deps.metrics) return reply.code(404).send({ code: "NOT_FOUND", message: "metrics not configured" });
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(deps.metrics.render());
  });

  app.get("/queue", async (req, reply) => {
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
}
