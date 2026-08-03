import { IssueLinkTypeSchema, IssuePrioritySchema, IssueStatusSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, resolveTeamRef, sendError } from "../route-context.js";
import { issueDocs } from "./issue.docs.js";
import { CreateIssueBodySchema } from "./request/create-issue.js";
import { IssueLinkInputSchema } from "./request/create-issue.js";
import { AcceptTriageBodySchema, DeclineTriageBodySchema, MoveIssueBodySchema } from "./request/move-issue.js";
import { SetIssueStatusBodySchema } from "./request/set-issue-status.js";
import { UpdateIssueBodySchema } from "./request/update-issue.js";

// The eval tracker's issues (docs/tracker.md) — "what problem are we evaluating", with the harnesses/datasets/
// judges/scorecards that verify it gathered on the record. Authz: read = issues:read (viewer+), write =
// issues:write (member+); delete additionally requires creator-or-admin (decided in the service). Agent
// attribution rides into the service so an agent-filed issue stamps causedBy — the trigger loop guard.
export function registerIssueRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/issues", { schema: issueDocs.create }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateIssueBodySchema>;
    try {
      body = CreateIssueBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.code(201).send(
        await deps.issueService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
          title: body.title,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.estimate !== undefined ? { estimate: body.estimate } : {}),
          ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
          ...(body.assignee !== undefined ? { assignee: body.assignee } : {}),
          ...(body.labelIds !== undefined ? { labelIds: body.labelIds } : {}),
          ...(body.links !== undefined ? { links: body.links } : {}),
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/issues", { schema: issueDocs.list }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        status: IssueStatusSchema.optional(),
        // One team, or every team the caller belongs to. `mine` resolves through the roster rather than
        // trusting a client-supplied id list.
        team: z.string().min(1).optional(),
        mine: z.enum(["true", "false"]).optional(),
        project: z.string().min(1).optional(),
        assignee: z.string().min(1).optional(),
        priority: IssuePrioritySchema.optional(),
        // One parent's sub-issues, or `none` for the TOP-LEVEL issues — what a board shows so a child never
        // appears twice, once on its own and once under its parent.
        parent: z.string().min(1).optional(),
        // One iteration's board, and the team's triage inbox.
        cycle: z.string().min(1).optional(),
        triage: z.enum(["true", "false"]).optional(),
        // "Which issues watch this harness" — the capability detail pages' reverse lookup.
        linkType: IssueLinkTypeSchema.optional(),
        linkId: z.string().min(1).optional(),
        // The bulk GitHub sync's working set. Exposed because the alternative a caller is left with is reading
        // the whole list and filtering client-side, which is what the issues page used to do.
        syncPull: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        cursor: z.string().min(1).optional(), // opaque token from a prior page's nextCursor
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const {
      status,
      team,
      mine,
      project,
      assignee,
      priority,
      parent,
      cycle,
      triage,
      linkType,
      linkId,
      syncPull,
      limit,
      cursor,
    } = query.data;
    if ((linkType === undefined) !== (linkId === undefined))
      return reply.code(400).send({ code: "BAD_REQUEST", message: "linkType and linkId must be given together." });
    // "My teams" is resolved here, not in the store: the roster lookup belongs to the team service, and the
    // store stays a plain id filter. An empty roster narrows to nothing rather than silently widening to all.
    const myTeamIds =
      mine === "true" && deps.teamService
        ? await deps.teamService.teamIdsFor(principal.workspace, principal.subject)
        : undefined;
    // A private team's issues are not the workspace's issues. The narrowing rides the SAME `teamIds` filter the
    // "my teams" view uses, so there is one code path in the store and no second place to forget it. When the
    // caller also asked for `mine`, the two intersect — you see your teams, minus the ones you may not.
    const visibleTeamIds = deps.teamService
      ? await deps.teamService.visibleTeamIds(principal.workspace, principal.subject, principal.roles.includes("admin"))
      : undefined;
    const teamScope =
      visibleTeamIds === undefined
        ? myTeamIds
        : myTeamIds === undefined
          ? visibleTeamIds
          : myTeamIds.filter((id) => visibleTeamIds.includes(id));
    // The filter names a team by id or by key (`?team=ENG`), because that is what the URL showing this list is
    // scoped by. An unknown ref 404s here rather than filtering to nothing.
    let teamId: string | undefined;
    try {
      teamId = team === undefined ? undefined : await resolveTeamRef(deps, principal.workspace, team);
    } catch (err) {
      return sendError(reply, err);
    }
    // One PAGE of the list projection (`{ items, nextCursor? }`) — a row's description and audit trail never
    // leave the database. `GET /issues/:id` is where the whole record lives.
    return reply.send(
      await deps.issueService.listSummaries(principal.workspace, {
        ...(status !== undefined ? { status } : {}),
        ...(teamId !== undefined ? { teamId } : {}),
        ...(teamScope !== undefined ? { teamIds: teamScope } : {}),
        ...(project !== undefined ? { projectId: project } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(parent !== undefined ? { parentId: parent === "none" ? null : parent } : {}),
        ...(cycle !== undefined ? { cycleId: cycle } : {}),
        ...(triage !== undefined ? { inTriage: triage === "true" } : {}),
        ...(linkType !== undefined && linkId !== undefined ? { link: { type: linkType, id: linkId } } : {}),
        ...(syncPull === "true" ? { syncPull: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/issues/:id", { schema: issueDocs.get }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      const issue = await deps.issueService.get(principal.workspace, req.params.id);
      // Same rule as a cross-workspace read: an issue you may not see is ABSENT, not forbidden.
      if (
        deps.teamService &&
        !(await deps.teamService.canSeeTeam(
          principal.workspace,
          issue.teamId,
          principal.subject,
          principal.roles.includes("admin"),
        ))
      )
        return reply.code(404).send({ code: "NOT_FOUND", message: `issue '${req.params.id}' not found.` });
      return reply.send(issue);
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  // The issue's evaluation history: the scorecards pinned as evidence UNION every batch the linked
  // datasets/harnesses ran — where a regression against a closed issue actually shows up.
  app.get<{ Params: { id: string } }>(
    "/issues/:id/scorecards",
    { schema: issueDocs.scorecards },
    async (req, reply) => {
      if (!deps.issueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        return reply.send(await deps.issueService.evaluationHistory(principal.workspace, req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/issues/:id", { schema: issueDocs.update }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateIssueBodySchema>;
    try {
      body = UpdateIssueBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueService.update(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/issues/:id/status", { schema: issueDocs.setStatus }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof SetIssueStatusBodySchema>;
    try {
      body = SetIssueStatusBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueService.setStatus(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // an illegal move is the domain's 409/400, verbatim
    }
  });

  // The team move. A transition, not an edit: it re-mints the identifier and emits `issue.moved`, so it gets
  // its own endpoint exactly like the status move does.
  app.post<{ Params: { id: string } }>("/issues/:id/team", { schema: issueDocs.move }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const body = MoveIssueBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueService.move(principal.workspace, req.params.id, body.data.teamId, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // already on that team → the domain's 409, verbatim
    }
  });

  // Triage — the queue in front of a team's workflow. Accepting puts the issue INTO the workflow; declining
  // cancels it with a reason (the issue stays on the record, because "we said no to this" is an answer somebody
  // will look for later).
  app.post<{ Params: { id: string } }>(
    "/issues/:id/triage/accept",
    { schema: issueDocs.acceptTriage },
    async (req, reply) => {
      if (!deps.issueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const body = AcceptTriageBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await deps.issueService.acceptTriage(principal.workspace, req.params.id, body.data.status, {
            subject: principal.subject,
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err); // not in triage → the domain's 409
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/issues/:id/triage/decline",
    { schema: issueDocs.declineTriage },
    async (req, reply) => {
      if (!deps.issueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const body = DeclineTriageBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await deps.issueService.declineTriage(principal.workspace, req.params.id, body.data.note, {
            subject: principal.subject,
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/issues/:id/links", { schema: issueDocs.link }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof IssueLinkInputSchema>;
    try {
      body = IssueLinkInputSchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueService.link(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; type: string; linkId: string } }>(
    "/issues/:id/links/:type/:linkId",
    { schema: issueDocs.unlink },
    async (req, reply) => {
      if (!deps.issueService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      const type = IssueLinkTypeSchema.safeParse(req.params.type);
      if (!type.success) return reply.code(400).send({ code: "BAD_REQUEST", message: type.error.message });
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await deps.issueService.unlink(principal.workspace, req.params.id, type.data, req.params.linkId, {
            subject: principal.subject,
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/issues/:id", { schema: issueDocs.delete }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.issueService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found; non-creator non-admin → 403
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
