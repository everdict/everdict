import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { visibleTeamsFor } from "../../common/team-scope.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { opsReportDocs } from "./ops-report.docs.js";

const OpsReportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

// GET /workspace/ops-report — the SLA-evidence read (metrics commercialization C1): the workspace's own
// execution health, the platform's failure share separated from the product's. Gated by scorecards:read (the
// Views precedent — the data belongs to the scorecard ledger; no new action for a new screen).
export function registerWorkspaceOpsReportRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/workspace/ops-report", { schema: opsReportDocs.read }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecards not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const query = OpsReportQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      gate(principal, "scorecards:read");
      const visibleTeams = await visibleTeamsFor(deps, principal);
      return reply.send(
        await deps.scorecardService.opsReport(principal.workspace, {
          ...(query.data.from !== undefined ? { from: query.data.from } : {}),
          ...(query.data.to !== undefined ? { to: query.data.to } : {}),
          ...(visibleTeams !== undefined ? { visibleTeams } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /workspace/audit/gates — B2, the governance window over recorded gate decisions (same gate: the
  // data belongs to the scorecard ledger).
  app.get("/workspace/audit/gates", { schema: opsReportDocs.gateAudit }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecards not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const query = OpsReportQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      gate(principal, "scorecards:read");
      const visibleTeams = await visibleTeamsFor(deps, principal);
      return reply.send(
        await deps.scorecardService.gateAudit(principal.workspace, {
          ...(query.data.from !== undefined ? { from: query.data.from } : {}),
          ...(query.data.to !== undefined ? { to: query.data.to } : {}),
          ...(visibleTeams !== undefined ? { visibleTeams } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
