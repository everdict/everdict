import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, resolveTeamRef, sendError, zodIssues } from "../route-context.js";
import { AddTeamMemberBodySchema, CreateTeamBodySchema, UpdateTeamBodySchema } from "./request/create-team.js";
import { CreateWorkflowStateBodySchema, UpdateWorkflowStateBodySchema } from "./request/workflow-state.js";
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
          ...(body.data.parentId !== undefined ? { parentId: body.data.parentId } : {}),
          ...(body.data.isPrivate !== undefined ? { isPrivate: body.data.isPrivate } : {}),
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
        // Private teams drop out for a non-member. The narrowing happens HERE, above the role gate, because it
        // is visibility rather than permission — `can()` still sees exactly the roles it always did.
        const visible = await deps.teamService.visibleTeamIds(
          principal.workspace,
          principal.subject,
          principal.roles.includes("admin"),
        );
        const teams = (
          await deps.teamService.list(principal.workspace, {
            ...(req.query.mine === "true" ? { member: principal.subject } : {}),
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          })
        ).filter((team) => visible === undefined || visible.includes(team.id));
        // ONE batched read for every row's counts. This was a `summary()` per team, and each of those listed
        // that team's issues in full — a workspace-sized read per row to produce three integers.
        const summaries = await deps.teamService.summaries(
          principal.workspace,
          teams.map((team) => team.id),
        );
        return reply.send(teams.map((team) => ({ ...team, summary: summaries.get(team.id) })));
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
      // A private team a non-member asks for reads as ABSENT, never as forbidden — a 403 would confirm it
      // exists, which is the whole thing the privacy is for.
      if (
        !(await deps.teamService.canSeeTeam(
          principal.workspace,
          team.id,
          principal.subject,
          principal.roles.includes("admin"),
        ))
      )
        return reply.code(404).send({ code: "NOT_FOUND", message: "Team not found." });
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

  // The team's board — its own names for the positions in its workflow. Read is teams:read like the rest of the
  // team surface; writing a board is workspace administration (teams:write), the same gate a rename has.
  app.get<{ Params: { id: string } }>("/teams/:id/states", { schema: teamDocs.listStates }, async (req, reply) => {
    if (!deps.workflowStateService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:read");
      // The board hangs off the team's own address, so it takes the same ref the team does (id or key).
      const teamId = await resolveTeamRef(deps, principal.workspace, req.params.id);
      return reply.send(await deps.workflowStateService.list(principal.workspace, teamId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/teams/:id/states", { schema: teamDocs.createState }, async (req, reply) => {
    if (!deps.workflowStateService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "teams:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = CreateWorkflowStateBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.workflowStateService.create({
          tenant: principal.workspace,
          teamId: await resolveTeamRef(deps, principal.workspace, req.params.id),
          ...body.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string; stateId: string } }>(
    "/teams/:id/states/:stateId",
    { schema: teamDocs.updateState },
    async (req, reply) => {
      if (!deps.workflowStateService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "teams:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const body = UpdateWorkflowStateBodySchema.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
      try {
        return reply.send(await deps.workflowStateService.update(principal.workspace, req.params.stateId, body.data));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; stateId: string } }>(
    "/teams/:id/states/:stateId",
    { schema: teamDocs.deleteState },
    async (req, reply) => {
      if (!deps.workflowStateService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "workflow states not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "teams:write");
        await deps.workflowStateService.remove(principal.workspace, req.params.stateId);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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
