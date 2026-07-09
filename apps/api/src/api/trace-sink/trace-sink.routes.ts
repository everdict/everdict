import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { traceSinkDocs } from "./trace-sink.docs.js";

// workspace trace sinks (multiple) — export judged scorecard detail to the team observability platform + the per-harness sink selection.
export function registerTraceSinkRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace trace sinks (multiple) — export judged scorecard detail to the team observability platform (MLflow, etc.) ---
  // Register multiple sinks by name and select them per-harness (a harness with no selection isn't exported — opt-in).
  // Read harnesses:read (viewer+ — to show the sink on the harness detail, the view is a name reference/URL only) / register·unregister settings:write /
  // per-harness selection harnesses:register (member+ — part of the harness config). Design: docs/architecture/trace-sink.md
  app.get("/workspace/trace-sinks", { schema: traceSinkDocs.list }, async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.traceSinkService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-sinks", { schema: traceSinkDocs.upsert }, async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(),
        authSecretName: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        webUrl: z.string().url().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.traceSinkService.upsert(principal.workspace, body.data);
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/trace-sinks/:name", { schema: traceSinkDocs.remove }, async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.traceSinkService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-harness sink selection — which sink to export to when that harness's scorecard completes. sink:null = deselect (export off).
  app.put("/harnesses/:id/trace-sink", { schema: traceSinkDocs.assign }, async (req, reply) => {
    if (!deps.traceSinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace sink service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ sink: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const assignments = await deps.traceSinkService.assign(principal.workspace, id, body.data.sink);
      return reply.send({ assignments });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
