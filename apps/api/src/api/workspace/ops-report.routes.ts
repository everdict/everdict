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

  // GET /workspace/metrics — C2, the workspace-scoped scrape: ONLY the calling workspace's ledger tallies,
  // rendered as an OpenMetrics text exposition. The safe counterpart of the operator-only /metrics (which
  // carries every tenant's labels): scoping comes from the authenticated principal, so a Prometheus armed
  // with an ak_ key sees exactly its own workspace. Rates render only when their denominator exists.
  app.get("/workspace/metrics", { schema: opsReportDocs.metrics }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecards not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const visibleTeams = await visibleTeamsFor(deps, principal);
      const report = await deps.scorecardService.opsReport(principal.workspace, {
        ...(visibleTeams !== undefined ? { visibleTeams } : {}),
      });
      const out: string[] = [];
      const gauge = (name: string, help: string, rows: Array<[string, number]>): void => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
        for (const [labels, value] of rows) out.push(`${name}${labels} ${value}`);
      };
      gauge(
        "everdict_workspace_batches",
        "Batch fates in this workspace's ledger.",
        (["succeeded", "failed", "cancelled", "superseded"] as const).map((s) => [
          `{status="${s}"}`,
          report.batches[s],
        ]),
      );
      gauge("everdict_workspace_case_outcome", "Case fates (CaseOutcome vocabulary).", [
        ['{outcome="verdicted"}', report.cases.verdicted],
        ['{outcome="unmeasured"}', report.cases.unmeasured],
        ['{outcome="infra_failed"}', report.cases.infraFailed],
        ['{outcome="cancelled"}', report.cases.cancelled],
      ]);
      gauge(
        "everdict_workspace_evidence_trace",
        "Evidence trace-plane tallies.",
        (["complete", "partial", "missing", "deferred"] as const).map((s) => [
          `{status="${s}"}`,
          report.evidence.trace[s],
        ]),
      );
      const rates: Array<[string, number]> = [];
      if (report.rates.infraFailure !== undefined) rates.push(['{rate="infra_failure"}', report.rates.infraFailure]);
      if (report.rates.unmeasured !== undefined) rates.push(['{rate="unmeasured"}', report.rates.unmeasured]);
      if (report.rates.traceComplete !== undefined) rates.push(['{rate="trace_complete"}', report.rates.traceComplete]);
      if (rates.length > 0)
        gauge("everdict_workspace_rate", "Ledger-derived rates (absent when the denominator is zero).", rates);
      return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(`${out.join("\n")}\n`);
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
