import { ownedByVisibleTeam } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertTeamVisible, visibleTeamsFor } from "../../common/team-scope.js";
import { type ServerDeps, gate, resolvePrincipal, resolveTeamRef, sendError } from "../route-context.js";
import { cycleDocs } from "./cycle.docs.js";
import { CompleteCycleBodySchema, CreateCycleBodySchema, UpdateCycleBodySchema } from "./request/create-cycle.js";

// A team's iterations (docs/tracker.md). AuthZ reuses the ISSUE pair (issues:read / issues:write): a cycle is
// how a team paces the issues it already owns, not a second kind of thing to be permitted separately. Delete
// additionally requires creator-or-admin, decided in the service like every other creator override.
export function registerCycleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/cycles", { schema: cycleDocs.create }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = CreateCycleBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.code(201).send(
        await deps.cycleService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          teamId: await resolveTeamRef(deps, principal.workspace, body.data.teamId),
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.description !== undefined ? { description: body.data.description } : {}),
          ...(body.data.startsAt !== undefined ? { startsAt: body.data.startsAt } : {}),
          ...(body.data.endsAt !== undefined ? { endsAt: body.data.endsAt } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/cycles", { schema: cycleDocs.list }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        team: z.string().min(1).optional(),
        // Only the iterations nobody has closed — what a planning screen shows. "Open" is the absence of an
        // explicit close, never a passed end date: a cycle whose end date passed but which nobody closed is a
        // cycle somebody forgot, and hiding it would be the wrong kind of tidy.
        open: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { team, open, limit } = query.data;
    try {
      // Named by id or by key (`?team=ENG`) — the same ref the team-scoped URL carries.
      const teamId = team === undefined ? undefined : await resolveTeamRef(deps, principal.workspace, team);
      const seen = await visibleTeamsFor(deps, principal);
      const cycles = await deps.cycleService.list(principal.workspace, {
        ...(teamId !== undefined ? { teamId } : {}),
        ...(open === "true" ? { open: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      // A cycle IS a team's — "Cycle 3" is that team's third — so it follows the team's own visibility.
      return reply.send(cycles.filter((cycle) => ownedByVisibleTeam(cycle, seen)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Detail carries the derived state (upcoming | active | completed) and the progress rollup; the list stays
  // lean, because the rollup is one issue query per row.
  app.get<{ Params: { id: string } }>("/cycles/:id", { schema: cycleDocs.get }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
      const cycle = await deps.cycleService.detail(principal.workspace, req.params.id);
      await assertTeamVisible(deps, principal, cycle.teamId, `cycle '${req.params.id}'`);
      return reply.send(cycle);
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  app.patch<{ Params: { id: string } }>("/cycles/:id", { schema: cycleDocs.update }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = UpdateCycleBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(
        await deps.cycleService.update(principal.workspace, req.params.id, body.data, {
          subject: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/cycles/:id/complete", { schema: cycleDocs.complete }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = CompleteCycleBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(
        await deps.cycleService.complete(principal.workspace, req.params.id, body.data, {
          subject: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/cycles/:id", { schema: cycleDocs.delete }, async (req, reply) => {
    if (!deps.cycleService) return reply.code(404).send({ code: "NOT_FOUND", message: "cycle service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
      await deps.cycleService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
