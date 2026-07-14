import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { traceSourceDocs } from "./trace-source.docs.js";

// workspace trace sources (multiple) — pull a dev-cluster-deployed harness's trace from its observability platform
// after a case runs, for grading/judging + the per-harness source selection. The inbound mirror of trace sinks.
export function registerTraceSourceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Read harnesses:read (viewer+ — the view is a name reference/URL only) / register·unregister settings:write /
  // per-harness selection harnesses:register (member+ — part of the harness config). Design: docs/service-harness.md
  app.get("/workspace/trace-sources", { schema: traceSourceDocs.list }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.traceSourceService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-sources", { schema: traceSourceDocs.upsert }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(),
        authSecretName: z.string().min(1).optional(),
        correlate: z.enum(["id", "tag"]).optional(),
        service: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.traceSourceService.upsert(principal.workspace, body.data);
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/trace-sources/:name", { schema: traceSourceDocs.remove }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.traceSourceService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-harness source selection — which registered source to pull this harness's case traces from. source:null = deselect.
  app.put("/harnesses/:id/trace-source", { schema: traceSourceDocs.assign }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ source: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const assignments = await deps.traceSourceService.assign(principal.workspace, id, body.data.source);
      return reply.send({ assignments });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
