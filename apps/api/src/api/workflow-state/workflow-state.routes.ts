import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { workflowStateDocs } from "./workflow-state.docs.js";

// The workspace's BOARD — its own names for the positions in its workflow, each declaring the canonical status
// it is a view onto. That indirection is the point: whatever a column is called, the release gate, the rollups
// and the regression watch all read the canonical status.
//
// Read-only: the board is what `ensureDefaults` seeded (plus any column a workspace added before the editor went
// away), and no surface edits it. Reading is `issues:read` (viewer+, the same gate the tracker's content has,
// because knowing the column names is as benign as knowing the issues).
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
}
