import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { agentAttributionFrom, fsActorFor } from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateViewBodySchema } from "./request/create-view.js";
import { UpdateViewBodySchema } from "./request/update-view.js";
import { viewDocs } from "./view.docs.js";

// Saved scorecard-analysis Views — a named AnalysisConfig (opaque). Read = shared + my private, edit·delete = owner·admin.
// Reuses scorecard read/run permissions (no new authz action): read = scorecards:read, write = scorecards:run.
export function registerViewRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/views", { schema: viewDocs.create }, async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateViewBodySchema>;
    try {
      body = CreateViewBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.viewService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          config: body.config,
          visibility: body.visibility,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/views", { schema: viewDocs.list }, async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.viewService.list(principal.workspace, principal.subject));
  });

  app.get<{ Params: { id: string } }>("/views/:id", { schema: viewDocs.get }, async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.viewService.get(principal.workspace, req.params.id, principal.subject)); // 404 if it's someone else's private view / not found
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Capture the View onto the workspace filesystem — the accumulating record behind the live lens.
  // Static suffix on the :id path; the snapshots themselves are read back through the ordinary /fs surface
  // (they are just files under views/<id>/), so there is deliberately no list endpoint here.
  app.post<{ Params: { id: string } }>(
    "/views/:id/snapshots",
    { schema: viewDocs.captureSnapshot },
    async (req, reply) => {
      if (!deps.viewSnapshotService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "view snapshot service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:run");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        return reply.send(
          await deps.viewSnapshotService.capture({
            tenant: principal.workspace,
            viewId: req.params.id,
            actor: fsActorFor(principal, agentAttributionFrom(req.headers)),
          }),
        );
      } catch (err) {
        return sendError(reply, err); // someone else's private view → 404 (no existence leak)
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/views/:id", { schema: viewDocs.update }, async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateViewBodySchema>;
    try {
      body = UpdateViewBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.viewService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      ); // 404 if not found (edit is creator·admin only → 403)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/views/:id", { schema: viewDocs.delete }, async (req, reply) => {
    if (!deps.viewService) return reply.code(404).send({ code: "NOT_FOUND", message: "view service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.viewService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found (delete is creator·admin only → 403)
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
