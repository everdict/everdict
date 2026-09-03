import { InitiativeStatusSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { initiativeDocs } from "./initiative.docs.js";
import { CreateInitiativeBodySchema } from "./request/create-initiative.js";
import { PostInitiativeUpdateBodySchema } from "./request/post-initiative-update.js";
import { SetInitiativeStatusBodySchema } from "./request/set-initiative-status.js";
import { UpdateInitiativeBodySchema } from "./request/update-initiative.js";

// The eval tracker's initiatives (docs/tracker.md) — the GOAL several projects work toward, whose progress is
// live arithmetic over everything underneath and whose completion is a gate on that arithmetic.
// Authz reuses the ISSUE pair (issues:read / issues:write): Initiative ⊃ Project ⊃ Issue is one resource family.
// Delete additionally requires creator-or-admin (decided in the service). An `InitiativeActor` is subject-only,
// so no agent attribution rides along — the causedBy loop guard lives where agents write, on issues.
export function registerInitiativeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/initiatives", { schema: initiativeDocs.create }, async (req, reply) => {
    if (!deps.initiativeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateInitiativeBodySchema>;
    try {
      body = CreateInitiativeBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.initiativeService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          ...(body.lead !== undefined ? { lead: body.lead } : {}),
          ...(body.memberIds !== undefined ? { memberIds: body.memberIds } : {}),
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.resources !== undefined ? { resources: body.resources } : {}),
          ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/initiatives", { schema: initiativeDocs.list }, async (req, reply) => {
    if (!deps.initiativeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        status: InitiativeStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { status, limit } = query.data;
    return reply.send(
      await deps.initiativeService.list(principal.workspace, {
        ...(status !== undefined ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  });

  // Detail carries the progress read — every project under the goal, each project's issues, one answer. It is a
  // fan-out, which is why the list never serves it.
  app.get<{ Params: { id: string } }>("/initiatives/:id", { schema: initiativeDocs.get }, async (req, reply) => {
    if (!deps.initiativeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.initiativeService.detail(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  app.patch<{ Params: { id: string } }>("/initiatives/:id", { schema: initiativeDocs.update }, async (req, reply) => {
    if (!deps.initiativeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateInitiativeBodySchema>;
    try {
      body = UpdateInitiativeBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.initiativeService.update(principal.workspace, req.params.id, body, { subject: principal.subject }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The posted-update timeline — where the goal stands in the words of the person answerable for it, and the
  // read a stakeholder goes to when the health colour changed.
  app.post<{ Params: { id: string } }>(
    "/initiatives/:id/updates",
    { schema: initiativeDocs.postUpdate },
    async (req, reply) => {
      if (!deps.initiativeService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const body = PostInitiativeUpdateBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.code(201).send(
          await deps.initiativeService.postUpdate(principal.workspace, req.params.id, body.data, {
            subject: principal.subject,
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/initiatives/:id/updates",
    { schema: initiativeDocs.listUpdates },
    async (req, reply) => {
      if (!deps.initiativeService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:read");
        return reply.send(await deps.initiativeService.listUpdates(principal.workspace, req.params.id, 50));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/initiatives/:id/status",
    { schema: initiativeDocs.setStatus },
    async (req, reply) => {
      if (!deps.initiativeService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof SetInitiativeStatusBodySchema>;
      try {
        body = SetInitiativeStatusBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.send(
          await deps.initiativeService.setStatus(
            principal.workspace,
            req.params.id,
            { status: body.status, ...(body.force !== undefined ? { force: body.force } : {}) },
            { subject: principal.subject },
          ),
        );
      } catch (err) {
        return sendError(reply, err); // the completion gate's refusal is the domain's 409, verbatim
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/initiatives/:id", { schema: initiativeDocs.delete }, async (req, reply) => {
    if (!deps.initiativeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "initiative service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.initiativeService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found; non-creator non-admin → 403; still holds projects → 409
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
