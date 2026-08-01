import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { AddTeamMemberBodySchema, CreateTeamBodySchema, UpdateTeamBodySchema } from "./request/create-team.js";
import { teamDocs } from "./team.docs.js";

// The tracker's teams (docs/tracker.md) — the grouping layer that owns issues and names them (`ENG-12`).
// Authz: read = teams:read (viewer+), write = teams:write (admin). Deletion additionally requires
// creator-or-admin, decided in the service like every other creator override.
export function registerTeamRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/teams", { schema: teamDocs.create }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = CreateTeamBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.teamService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          key: body.data.key,
          name: body.data.name,
          ...(body.data.description !== undefined ? { description: body.data.description } : {}),
          ...(body.data.isDefault !== undefined ? { isDefault: body.data.isDefault } : {}),
          ...(body.data.members !== undefined ? { members: body.data.members } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { mine?: string; limit?: string } }>(
    "/teams",
    { schema: teamDocs.list },
    async (req, reply) => {
      if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "teams:read");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        // Reading the list is also the invariant's repair point: a workspace that has never had a team gets its
        // default here rather than at some creation path someone forgot to call.
        await deps.teamService.ensureDefault(principal.workspace, principal.subject);
        const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
        const teams = await deps.teamService.list(principal.workspace, {
          ...(req.query.mine === "true" ? { member: principal.subject } : {}),
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        });
        return reply.send(
          await Promise.all(
            teams.map(async (team) => ({
              ...team,
              summary: await deps.teamService?.summary(principal.workspace, team.id),
            })),
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/teams/:id", { schema: teamDocs.get }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:read");
      const team = await deps.teamService.get(principal.workspace, req.params.id);
      return reply.send({ ...team, summary: await deps.teamService.summary(principal.workspace, team.id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/teams/:id", { schema: teamDocs.update }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = UpdateTeamBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.send(
        await deps.teamService.update(principal.workspace, req.params.id, body.data, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/teams/:id/default", { schema: teamDocs.makeDefault }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
      return reply.send(
        await deps.teamService.makeDefault(principal.workspace, req.params.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/teams/:id", { schema: teamDocs.delete }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
      await deps.teamService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/teams/:id/members", { schema: teamDocs.listMembers }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:read");
      return reply.send(await deps.teamService.listMembers(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/teams/:id/members", { schema: teamDocs.addMember }, async (req, reply) => {
    if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = AddTeamMemberBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.teamService.addMember(principal.workspace, req.params.id, body.data.subject, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; subject: string } }>(
    "/teams/:id/members/:subject",
    { schema: teamDocs.removeMember },
    async (req, reply) => {
      if (!deps.teamService) return reply.code(404).send({ code: "NOT_FOUND", message: "team service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "teams:write");
        await deps.teamService.removeMember(principal.workspace, req.params.id, req.params.subject, {
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

// Query DTO kept next to the routes that read it — the issue list narrows by team the same way it narrows by
// status, and "my teams" resolves through the roster rather than a client-supplied id list.
export const IssueTeamQuerySchema = z.object({
  teamId: z.string().min(1).optional(),
  mine: z.enum(["true", "false"]).optional(),
});
