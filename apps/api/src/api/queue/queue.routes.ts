import type { FastifyInstance } from "fastify";
import { type ServerDeps, constantTimeEq, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
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
}
