import { EVERDICT_ROLES } from "@everdict/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// invites (token/link redemption; issue/list/revoke = admin, accept = authenticated, preview = public-by-token).
export function registerInviteRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- invites (token/link redemption; issue/list/revoke = admin, accept = authenticated only) ---
  app.get("/invites", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write"); // an invite is a join secret → listing is admin too
      return reply.send(await deps.membershipService.listInvites(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/invites", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ role: z.enum(EVERDICT_ROLES), expiresInHours: z.number().int().positive().max(8760).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "members:write");
      const { token, meta } = await deps.membershipService.createInvite({
        workspace: principal.workspace,
        role: body.data.role,
        createdBy: principal.subject,
        ...(body.data.expiresInHours !== undefined ? { expiresInHours: body.data.expiresInHours } : {}),
      });
      return reply.code(201).send({ ...meta, token }); // the plaintext token is returned only once here (embedded in the link)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/invites/:id", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:write");
      await deps.membershipService.revokeInvite(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Accept — no workspace-role gate (pre-join). Authenticated subject only (self-serve like POST /workspaces). Independent of the active workspace.
  app.post("/invites/accept", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.membershipService.acceptInvite(principal, body.data.token));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Preview — unauthenticated (the token is the secret). Returns only workspace name/logo/role without redeeming (for the link landing). Invalid/expired/accepted = 404.
  app.get<{ Querystring: { token?: string } }>("/invites/preview", async (req, reply) => {
    if (!deps.membershipService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "membership service not configured" });
    const token = req.query.token;
    if (!token) return reply.code(400).send({ code: "BAD_REQUEST", message: "token is required." });
    try {
      return reply.send(await deps.membershipService.previewInvite(token));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
