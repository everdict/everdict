import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DRIVER_WORKFLOW_FAMILIES, type DriverWorkflowFamily } from "../../core/ops/driver-ops-service.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { driverDocs } from "./driver.docs.js";

const familySchema = z.enum(DRIVER_WORKFLOW_FAMILIES);

// Driver ops surface v0 (docs/orchestration.md, lesson-044 adoption gate): the durable driver readable and
// controllable ONLY through this wrap — ledger-vocabulary addressing, role gates, ledger-ownership scoping.
// Read = runtimes:read (diagnostics); cancel = runtimes:control (destructive, admin-only — the same posture
// as live-cluster runtime control). Ownership is checked against the family's OWN ledger (batch/score →
// scorecard rows, approval → the approval store) BEFORE Temporal is asked (no existence leak).
export function registerDriverOpsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const ownershipGuard = async (tenant: string, family: DriverWorkflowFamily, id: string): Promise<boolean> => {
    // approval ledger ids live in the approval store; reaper ids are sandbox RUN rows; batch/score ids are scorecard rows.
    if (family === "approval") {
      const approval = await deps.approvalService?.get(tenant, id).catch(() => undefined);
      return approval !== undefined;
    }
    if (family === "reaper") {
      const run = await deps.service.get(id).catch(() => undefined);
      return run !== undefined && run.tenant === tenant && run.kind === "sandbox";
    }
    if (family === "reaction") {
      // Ledger id = `<eventId>-<subscriptionId>`; the rule's row is the tenant's ownership proof (a deleted
      // rule hides its historical chains from the wrap — the coarse tradeoff of pointer-based scoping).
      const rule = await deps.subscriptionService?.get(tenant, id.slice(-36)).catch(() => undefined);
      return rule !== undefined;
    }
    const record = await deps.scorecardService?.get(id);
    return record !== undefined && record?.tenant === tenant;
  };

  app.get<{ Params: { family: string; id: string } }>(
    "/ops/driver/:family/:id",
    { schema: driverDocs.describe },
    async (req, reply) => {
      if (!deps.driverOps)
        return reply.code(404).send({ code: "NOT_FOUND", message: "driver ops not configured (no Temporal address)" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runtimes:read");
        const family = familySchema.parse(req.params.family) as DriverWorkflowFamily;
        if (!(await ownershipGuard(principal.workspace, family, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "no such record in this workspace." });
        return reply.send(await deps.driverOps.describe(family, req.params.id));
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply
            .code(400)
            .send({ code: "BAD_REQUEST", message: "family must be batch | score | approval | reaper | reaction" });
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { family: string; id: string } }>(
    "/ops/driver/:family/:id/cancel",
    { schema: driverDocs.cancel },
    async (req, reply) => {
      if (!deps.driverOps)
        return reply.code(404).send({ code: "NOT_FOUND", message: "driver ops not configured (no Temporal address)" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runtimes:control");
        const family = familySchema.parse(req.params.family) as DriverWorkflowFamily;
        if (!(await ownershipGuard(principal.workspace, family, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "no such record in this workspace." });
        await deps.driverOps.cancel(family, req.params.id);
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof z.ZodError)
          return reply
            .code(400)
            .send({ code: "BAD_REQUEST", message: "family must be batch | score | approval | reaper | reaction" });
        return sendError(reply, err);
      }
    },
  );
}
