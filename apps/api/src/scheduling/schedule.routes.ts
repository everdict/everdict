import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateScheduleBodySchema, UpdateScheduleBodySchema } from "./schedule.schema.js";

// scheduled (cron) scorecards — stored RunScorecardInput + cron expression + policy. Firing (Temporal Schedule) is slice 2.
// The fired run's submittedBy = the creator (principal.subject): budget → tenant, private-repo connection resolution.
export function registerScheduleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/schedules", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateScheduleBodySchema>;
    try {
      body = CreateScheduleBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply
        .code(201)
        .send(
          await deps.scheduleService.create({ tenant: principal.workspace, createdBy: principal.subject, ...body }),
        );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/schedules", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.scheduleService.list(principal.workspace));
  });

  app.get<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.scheduleService.get(principal.workspace, req.params.id)); // 404 if not found
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateScheduleBodySchema>;
    try {
      body = UpdateScheduleBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.scheduleService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      ); // 404 if not found (content edits are creator·admin only → 403)
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "schedule service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "schedules:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.scheduleService.remove(principal.workspace, req.params.id); // 404 if not found
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
