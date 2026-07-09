import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { CreateCommentBodySchema } from "./request/create-comment.js";

// comments (resource comments — collaborative discussion on datasets, etc.; read = viewer+, write = member+, delete = author-or-admin)
export function registerCommentRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/comments", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = req.query as { resourceType?: string; resourceId?: string };
    if (!q.resourceType || !q.resourceId)
      return reply.code(400).send({ code: "BAD_REQUEST", message: "resourceType and resourceId are required." });
    try {
      gate(principal, "comments:read");
      const comments = await deps.commentService.list(principal.workspace, q.resourceType, q.resourceId);
      return reply.send({ comments });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/comments", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = CreateCommentBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "comments:write");
      const comment = await deps.commentService.create({
        tenant: principal.workspace,
        resourceType: body.data.resourceType,
        resourceId: body.data.resourceId,
        author: principal.subject,
        body: body.data.body,
        ...(body.data.parentId ? { parentId: body.data.parentId } : {}),
        ...(body.data.mentions ? { mentions: body.data.mentions } : {}),
      });
      return reply.code(201).send(comment);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/comments/:id", async (req, reply) => {
    if (!deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "comment service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // Author-or-admin is decided by the service (the route only authenticates) — the same creator-override pattern as datasets:delete.
      await deps.commentService.delete({
        tenant: principal.workspace,
        id: req.params.id,
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
