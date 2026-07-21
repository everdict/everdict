import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { SubmitBodySchema } from "./request/submit.js";
import { runDocs } from "./run.docs.js";

// runs — the async execution primitive: submit returns a run id; the result arrives by poll or webhook.
export function registerRunRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/runs", { schema: runDocs.submit }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      gate(principal, "runs:submit");
      // submittedBy=subject → clone a private-repo seed with the submitter's personal connection ("clone with my connection").
      return reply
        .code(202)
        .send(await deps.service.submit({ tenant: principal.workspace, submittedBy: principal.subject, ...body }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", { schema: runDocs.get }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const record = await deps.service.get(req.params.id);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { scorecardId?: string; scope?: string; runner?: string; limit?: string } }>(
    "/runs",
    { schema: runDocs.list },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        // scorecardId → that batch's child runs (case drill-down); scope=all → standalone + scorecard children
        // (activity console's "all executions", grouped in the UI); runner → runs a self-hosted runner executed
        // (runner-detail activity feed, capped by limit); otherwise the standalone activity list.
        const { scorecardId, scope, runner, limit } = req.query;
        const parsedLimit = limit !== undefined && /^\d+$/.test(limit) ? Number(limit) : undefined;
        const opts = scorecardId
          ? { scorecardId }
          : runner
            ? { runnerId: runner, ...(parsedLimit ? { limit: parsedLimit } : {}) }
            : scope === "all"
              ? { includeChildren: true }
              : undefined;
        return reply.send(await deps.service.list(principal.workspace, opts));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
