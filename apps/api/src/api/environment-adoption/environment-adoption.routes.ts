import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { environmentAdoptionDocs } from "./environment-adoption.docs.js";

// Workspace environment-image adoption (import) — a workspace-level inventory of environment capabilities the
// workspace has brought in, each with a pull-usability verification snapshot (warn-not-block). Browse is
// capabilities:read (viewer+); adopt/unadopt/verify are settings:write (workspace-level config, like image-registries).
// The image/name/contents come from the live capability record. Design: docs/architecture/environment-image-store.md.
export function registerEnvironmentAdoptionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const notConfigured = { code: "NOT_FOUND", message: "environment adoption service not configured" };

  app.get("/workspace/adopted-environments", { schema: environmentAdoptionDocs.list }, async (req, reply) => {
    if (!deps.environmentAdoptionService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "capabilities:read");
      return reply.send({
        environments: await deps.environmentAdoptionService.list(principal.workspace, principal.subject),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/adopted-environments", { schema: environmentAdoptionDocs.adopt }, async (req, reply) => {
    if (!deps.environmentAdoptionService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({ source: z.string().min(1), id: z.string().min(1), version: z.string().min(1) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.environmentAdoptionService.adopt(principal.workspace, principal.subject, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Re-run the pull check for one adopted environment (settings:write).
  app.post("/workspace/adopted-environments/verify", { schema: environmentAdoptionDocs.verify }, async (req, reply) => {
    if (!deps.environmentAdoptionService) return reply.code(404).send(notConfigured);
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ source: z.string().min(1), id: z.string().min(1) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(
        await deps.environmentAdoptionService.reverify(
          principal.workspace,
          principal.subject,
          body.data.source,
          body.data.id,
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { source: string; id: string } }>(
    "/workspace/adopted-environments/:source/:id",
    { schema: environmentAdoptionDocs.unadopt },
    async (req, reply) => {
      if (!deps.environmentAdoptionService) return reply.code(404).send(notConfigured);
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "settings:write");
        await deps.environmentAdoptionService.unadopt(principal.workspace, req.params.source, req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
