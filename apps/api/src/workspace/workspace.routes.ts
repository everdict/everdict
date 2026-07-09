import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// workspaces (self-serve membership: list + create) + the singular /workspace metadata record (name/logo/owner; delete = owner only).
export function registerWorkspaceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspaces (self-serve membership: my workspace list + create) ---
  // Create is self-serve for anyone (no in-workspace role gate) — the creator is the admin of that workspace.
  app.get("/workspaces", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    return reply.send(await deps.workspaceService.listForSubject(principal.subject));
  });

  app.post("/workspaces", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ name: z.string().min(1), id: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.code(201).send(await deps.workspaceService.create(principal.subject, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  // --- workspace metadata (name/logo/owner) — singular /workspace = the active workspace record (distinct from plural /workspaces) ---
  app.get("/workspace", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send(await deps.workspaceService.get(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch("/workspace", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ name: z.string().optional(), logoUrl: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.workspaceService.update(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Delete is owner (creator) only — no role gate. The service compares principal.subject to the record owner and throws ForbiddenError (403).
  app.delete("/workspace", async (req, reply) => {
    if (!deps.workspaceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      await deps.workspaceService.delete(principal.workspace, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
