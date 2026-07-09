import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// the current principal (/me: identity + workspaces + profile) and profile editing.
export function registerProfileRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/me", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const workspaces = deps.workspaceService
      ? await deps.workspaceService.listForSubject(principal.subject)
      : undefined;
    // Profile (name/username/avatar) is control-plane-owned mutable info — layered on top of the Principal (email and other SSO claims).
    const profile = deps.profileService ? await deps.profileService.get(principal.subject) : undefined;
    return reply.send({
      ...principal,
      ...(workspaces ? { workspaces } : {}),
      ...(profile ? { profile } : {}),
    });
  });

  // Edit my profile (self-serve — no role gate, subject = self). email is immutable since it's SSO (not accepted here).
  app.patch("/me/profile", async (req, reply) => {
    if (!deps.profileService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "profile service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ name: z.string().optional(), username: z.string().optional(), avatarUrl: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.profileService.update(principal.subject, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
