import { originSource } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { serveScorecard } from "../scorecard/serve.js";
import { groupDocs } from "./group.docs.js";
import { RunExperimentBodySchema } from "./request/run-experiment.js";

// Run groups (execution-model.md P1) — the kind-aware surface over ScorecardRecord (decision O3: the group
// generalizes the record in concept, the table is kept). v0 submits EXPERIMENTS (ungraded phase-1 fan-out);
// real scorecards keep POST /scorecards. Authz reuses the scorecard actions (no new action, views precedent).
export function registerGroupRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/groups", { schema: groupDocs.submit }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof RunExperimentBodySchema>;
    try {
      body = RunExperimentBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(202).send(
        serveScorecard(
          await deps.scorecardService.submitExperiment({
            tenant: principal.workspace,
            submittedBy: principal.subject,
            harness: body.harness,
            ...(body.dataset ? { dataset: body.dataset } : {}),
            ...(body.task ? { task: body.task } : {}),
            ...(body.trials !== undefined ? { trials: body.trials } : {}),
            ...(body.runtime ? { runtime: body.runtime } : {}),
            ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
            ...(body.retries !== undefined ? { retries: body.retries } : {}),
            ...(body.cases ? { cases: body.cases } : {}),
            origin: { source: originSource(principal.via) },
          }),
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The group record with hydrated detail — same semantics as GET /scorecards/:id (one table, kind-aware name).
  app.get<{ Params: { id: string } }>("/groups/:id", { schema: groupDocs.get }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const record = await deps.scorecardService.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "group not found." });
      return reply.send(serveScorecard(record));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
