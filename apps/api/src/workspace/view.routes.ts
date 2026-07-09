import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateViewBodySchema, UpdateViewBodySchema } from "./view.schema.js";

// Saved scorecard-analysis Views — a named AnalysisConfig (opaque). Read = shared + my private, edit·delete = owner·admin.
// Reuses scorecard read/run permissions (no new authz action): read = scorecards:read, write = scorecards:run.
export function registerViewRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/views", async (req, reply) => {
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

  app.get("/views", async (req, reply) => {
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

  app.get<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
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

  app.patch<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
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

  app.delete<{ Params: { id: string } }>("/views/:id", async (req, reply) => {
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
