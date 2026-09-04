import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { CreateWorkflowStateBodySchema, UpdateWorkflowStateBodySchema } from "./request/workflow-state.js";
import { workflowStateDocs } from "./workflow-state.docs.js";

// The workspace's BOARD — its own names for the positions in its workflow, each declaring the canonical status
// it is a view onto. That indirection is the point: a column can be renamed, recoloured, reordered or added
// without any of it reaching the release gate, the rollups or the regression watch, which all read the
// canonical status.
//
// the only boundary now, so the board is workspace administration — read is `issues:read` (viewer+, the same
// gate the tracker's content has, because knowing the column names is as benign as knowing the issues), and
// every write is `settings:write` (admin), which is where shaping a workspace has always lived.
export function registerWorkflowStateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/workflow-states", { schema: workflowStateDocs.list }, async (req, reply) => {
    if (!deps.workflowStateService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      return reply.send(await deps.workflowStateService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/workflow-states", { schema: workflowStateDocs.create }, async (req, reply) => {
    if (!deps.workflowStateService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = CreateWorkflowStateBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.workflowStateService.create({
          tenant: principal.workspace,
          ...body.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/workflow-states/:id",
    { schema: workflowStateDocs.update },
    async (req, reply) => {
      if (!deps.workflowStateService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "settings:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const body = UpdateWorkflowStateBodySchema.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
      try {
        return reply.send(await deps.workflowStateService.update(principal.workspace, req.params.id, body.data));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/workflow-states/:id",
    { schema: workflowStateDocs.delete },
    async (req, reply) => {
      if (!deps.workflowStateService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "settings:write");
        await deps.workflowStateService.remove(principal.workspace, req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
