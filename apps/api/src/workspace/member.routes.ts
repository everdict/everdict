import { EVERDICT_ROLES } from "@everdict/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// workspace members (read = viewer+, role change/remove = admin, leave = self).
export function registerMemberRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace members (read = viewer+, role change/remove = admin) ---
  app.get("/members", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send(await deps.membershipService.listMembers(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { subject: string } }>("/members/:subject", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ role: z.enum(EVERDICT_ROLES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "members:write");
      await deps.membershipService.setRole(principal.workspace, req.params.subject, body.data.role);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Leave this workspace myself (self-serve — no role gate, only my own membership). A static route, so it takes precedence over /members/:subject.
  // The last admin cannot leave (409). On success the client moves to another workspace (or onboarding).
  app.delete("/members/me", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      await deps.membershipService.leaveWorkspace(principal.workspace, principal.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { subject: string } }>("/members/:subject", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write");
      await deps.membershipService.removeMember(principal.workspace, req.params.subject);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
