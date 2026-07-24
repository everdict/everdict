import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { capabilityDocs } from "./capability.docs.js";
import { SaveCapabilityBodySchema } from "./request/save-capability.js";
import { SetCapabilityVisibilityBodySchema } from "./request/set-capability-visibility.js";

// Capability Store — one discriminated versioned entity (mcp|code|skill) members author, publish at a reach tier
// (private|workspace|subset|public), and adopt into their agent. Read = capabilities:read (viewer+); author/publish/
// edit-reach/delete = capabilities:write (member+) PLUS the service's owner-or-admin gate (publishing 'public' needs
// an admin). Cross-tenant reads (subset/public) are authorized by canConsumeCapability in the service.
export function registerCapabilityRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const notConfigured = { code: "NOT_FOUND", message: "capabilities not configured" };
  const actorOf = (principal: { subject: string; roles: string[] }) => ({
    subject: principal.subject,
    isAdmin: principal.roles.includes("admin"),
  });

  app.put<{ Params: { id: string } }>("/capabilities/:id", { schema: capabilityDocs.save }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = SaveCapabilityBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.capabilityService.save(principal.workspace, actorOf(principal), req.params.id, parsed.data),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/capabilities", { schema: capabilityDocs.list }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send(await deps.capabilityService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/capabilities/public", { schema: capabilityDocs.listPublic }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send(await deps.capabilityService.listPublic());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/capabilities/:id", { schema: capabilityDocs.get }, async (req, reply) => {
    if (!deps.capabilityService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send(await deps.capabilityService.get(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // not visible / missing → 404
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/capabilities/:id/versions/:version",
    { schema: capabilityDocs.getVersion },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:read");
        return reply.send(
          await deps.capabilityService.get(principal.workspace, req.params.id, principal.subject, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/capabilities/:id/visibility",
    { schema: capabilityDocs.setVisibility },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const parsed = SetCapabilityVisibilityBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deps.capabilityService.setVisibility(
            principal.workspace,
            req.params.id,
            { visibility: parsed.data.visibility, sharedWith: parsed.data.sharedWith },
            actorOf(principal),
          ),
        );
      } catch (err) {
        return sendError(reply, err); // owner-or-admin / public-admin gate → 403/404
      }
    },
  );

  app.delete<{ Params: { id: string; version: string } }>(
    "/capabilities/:id/versions/:version",
    { schema: capabilityDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.capabilityService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "capabilities:write");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        await deps.capabilityService.deleteVersion(
          principal.workspace,
          req.params.id,
          req.params.version,
          actorOf(principal),
        );
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err); // creator-or-admin gate → 403/404
      }
    },
  );
}
