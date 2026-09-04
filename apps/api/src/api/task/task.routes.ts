import { AgentTaskStatusSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateTaskBodySchema } from "./request/create-task.js";
import { UpdateTaskBodySchema } from "./request/update-task.js";
import { taskDocs } from "./task.docs.js";

// Authz reuses the agent actions (no new action): read = agents:read, write = agents:write; delete additionally
// requires creator-or-admin (decided in the service). Agent attribution (the forwarded conversation headers)
// rides into the service so agent-created/claimed tasks stamp causedBy — the trigger loop guard.
export function registerTaskRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/tasks", { schema: taskDocs.create }, async (req, reply) => {
    if (!deps.taskService) return reply.code(404).send({ code: "NOT_FOUND", message: "task service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateTaskBodySchema>;
    try {
      body = CreateTaskBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.code(201).send(
        await deps.taskService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          subject: body.subject,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.owner !== undefined ? { owner: body.owner } : {}),
          blockedBy: body.blockedBy,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/tasks", { schema: taskDocs.list }, async (req, reply) => {
    if (!deps.taskService) return reply.code(404).send({ code: "NOT_FOUND", message: "task service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        status: AgentTaskStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    return reply.send(await deps.taskService.list(principal.workspace, query.data));
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", { schema: taskDocs.get }, async (req, reply) => {
    if (!deps.taskService) return reply.code(404).send({ code: "NOT_FOUND", message: "task service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.taskService.get(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  app.patch<{ Params: { id: string } }>("/tasks/:id", { schema: taskDocs.update }, async (req, reply) => {
    if (!deps.taskService) return reply.code(404).send({ code: "NOT_FOUND", message: "task service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateTaskBodySchema>;
    try {
      body = UpdateTaskBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.taskService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", { schema: taskDocs.delete }, async (req, reply) => {
    if (!deps.taskService) return reply.code(404).send({ code: "NOT_FOUND", message: "task service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.taskService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found; non-creator non-admin → 403
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
