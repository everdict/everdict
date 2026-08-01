import { ProjectStatusSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { projectDocs } from "./project.docs.js";
import { CreateProjectBodySchema } from "./request/create-project.js";
import { SetProjectStatusBodySchema } from "./request/set-project-status.js";
import { UpdateProjectBodySchema } from "./request/update-project.js";

// The eval tracker's projects (docs/tracker.md) — issues grouped under one target date, so "did we finish the
// evaluation in time" is a question the tracker answers. Authz reuses the ISSUE pair (issues:read / issues:write):
// Initiative ⊃ Project ⊃ Issue is one resource family, and a member who may move an issue may hold its container.
// Delete additionally requires creator-or-admin (decided in the service). No agent attribution here — a
// `ProjectActor` is subject-only; the causedBy loop guard lives where agents actually write, on issues.
export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/projects", { schema: projectDocs.create }, async (req, reply) => {
    if (!deps.projectService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof CreateProjectBodySchema>;
    try {
      body = CreateProjectBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(201).send(
        await deps.projectService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.initiativeId !== undefined ? { initiativeId: body.initiativeId } : {}),
          ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/projects", { schema: projectDocs.list }, async (req, reply) => {
    if (!deps.projectService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        status: ProjectStatusSchema.optional(),
        // "Which projects sit under this initiative" — the readiness page's drill-down.
        initiative: z.string().min(1).optional(),
        // "Which projects is this team working on" — the sidebar's per-team Projects entry. Derived from the
        // team's issues (a project has no team of its own), so it answers what the team has actually touched.
        team: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { status, initiative, team, limit } = query.data;
    return reply.send(
      await deps.projectService.list(principal.workspace, {
        ...(status !== undefined ? { status } : {}),
        ...(initiative !== undefined ? { initiativeId: initiative } : {}),
        ...(team !== undefined ? { teamId: team } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  });

  // Detail carries the issue rollup; the list stays lean (the rollup is derived per read, so serving it in a
  // list would fan out one issue query per row).
  app.get<{ Params: { id: string } }>("/projects/:id", { schema: projectDocs.get }, async (req, reply) => {
    if (!deps.projectService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:read");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      return reply.send(await deps.projectService.detail(principal.workspace, req.params.id));
    } catch (err) {
      return sendError(reply, err); // another workspace's id → 404 (tenant-scoped store, no existence leak)
    }
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", { schema: projectDocs.update }, async (req, reply) => {
    if (!deps.projectService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof UpdateProjectBodySchema>;
    try {
      body = UpdateProjectBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.send(
        await deps.projectService.update(principal.workspace, req.params.id, body, { subject: principal.subject }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/projects/:id/status",
    { schema: projectDocs.setStatus },
    async (req, reply) => {
      if (!deps.projectService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      let body: z.infer<typeof SetProjectStatusBodySchema>;
      try {
        body = SetProjectStatusBodySchema.parse(req.body);
      } catch (err) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
      }
      try {
        return reply.send(
          await deps.projectService.setStatus(
            principal.workspace,
            req.params.id,
            { status: body.status, ...(body.force !== undefined ? { force: body.force } : {}) },
            { subject: principal.subject },
          ),
        );
      } catch (err) {
        return sendError(reply, err); // completing with open issues (unforced) is the domain's 409, verbatim
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/projects/:id", { schema: projectDocs.delete }, async (req, reply) => {
    if (!deps.projectService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "project service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    try {
      await deps.projectService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      }); // 404 if not found; non-creator non-admin → 403; still holds issues → 409
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
