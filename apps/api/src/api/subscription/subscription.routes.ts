import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { CreateSubscriptionBodySchema } from "./request/create-subscription.js";
import { UpdateSubscriptionBodySchema } from "./request/update-subscription.js";
import { subscriptionDocs } from "./subscription.docs.js";

// Subscription registry (event-plumbing.md E3 §6) — selector → reaction under governance. Reuses the agent
// authz actions (read = agents:read, write = agents:write; no new action) since a subscription is automation
// config of the same trust class as agent triggers; edit/delete = creator or admin (in the service).
export function registerSubscriptionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/subscriptions", { schema: subscriptionDocs.create }, async (req, reply) => {
    if (!deps.subscriptionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "subscription service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateSubscriptionBodySchema>;
    try {
      body = CreateSubscriptionBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.subscriptionService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          selector: body.selector,
          reaction: body.reaction,
          ...(body.governance !== undefined ? { governance: body.governance } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/subscriptions", { schema: subscriptionDocs.list }, async (req, reply) => {
    if (!deps.subscriptionService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "subscription service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "agents:read");
    } catch (err) {
      return sendError(reply, err);
    }
    return reply.send(await deps.subscriptionService.list(principal.workspace));
  });

  app.patch<{ Params: { id: string } }>(
    "/subscriptions/:id",
    { schema: subscriptionDocs.update },
    async (req, reply) => {
      if (!deps.subscriptionService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "subscription service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:write");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof UpdateSubscriptionBodySchema>;
      try {
        body = UpdateSubscriptionBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.send(
          await deps.subscriptionService.update(principal.workspace, req.params.id, body, {
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          }),
        ); // missing / another workspace's id → 404; non-creator non-admin → 403
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/subscriptions/:id",
    { schema: subscriptionDocs.delete },
    async (req, reply) => {
      if (!deps.subscriptionService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "subscription service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "agents:write");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        await deps.subscriptionService.remove(principal.workspace, req.params.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
