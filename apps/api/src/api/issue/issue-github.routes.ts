import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { issueGithubDocs } from "./issue-github.docs.js";
import {
  ImportGithubIssuesBodySchema,
  IssueGithubSyncBodySchema,
  PullGithubIssuesBodySchema,
} from "./request/import-github-issues.js";

// GitHub import + MANUAL two-way sync for the tracker's issues (docs/tracker.md). Everdict stays the client —
// there is no webhook and no periodic sweep, so a pull happens when someone presses Sync and a push happens as
// the effect of a local transition. Gated issues:write throughout: importing and syncing MUTATE tracker content,
// and the underlying GitHub reads ride the workspace App's own installation scope.
export function registerIssueGithubRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // What can still be imported from a repo — its issues minus pull requests minus what this workspace already has.
  app.get("/issues/import/candidates", { schema: issueGithubDocs.candidates }, async (req, reply) => {
    if (!deps.issueSync)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue GitHub sync not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const query = z
      .object({
        repository: z.string().min(1),
        host: z.string().min(1).optional(),
        state: z.enum(["open", "closed", "all"]).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      return reply.send(await deps.issueSync.importCandidates(principal.workspace, query.data));
    } catch (err) {
      return sendError(reply, err); // no App installed on the repo → the service's 404
    }
  });

  app.post("/issues/import", { schema: issueGithubDocs.import }, async (req, reply) => {
    if (!deps.issueSync)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue GitHub sync not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof ImportGithubIssuesBodySchema>;
    try {
      body = ImportGithubIssuesBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.code(201).send(
        await deps.issueSync.import(principal.workspace, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Bulk pull: one incremental list call over the repo's sync-enabled copies, per-issue outcomes returned.
  app.post("/issues/sync", { schema: issueGithubDocs.pullRepository }, async (req, reply) => {
    if (!deps.issueSync)
      return reply.code(404).send({ code: "NOT_FOUND", message: "issue GitHub sync not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof PullGithubIssuesBodySchema>;
    try {
      body = PullGithubIssuesBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueSync.pullRepository(principal.workspace, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/issues/:id/sync",
    { schema: issueGithubDocs.pullIssue },
    async (req, reply) => {
      if (!deps.issueSync)
        return reply.code(404).send({ code: "NOT_FOUND", message: "issue GitHub sync not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "issues:write");
      } catch (err) {
        return sendError(reply, err);
      }
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await deps.issueSync.pullIssue(principal.workspace, req.params.id, {
            subject: principal.subject,
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string } }>("/issues/:id/github", { schema: issueGithubDocs.setSync }, async (req, reply) => {
    if (!deps.issueService) return reply.code(404).send({ code: "NOT_FOUND", message: "issue service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "issues:write");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof IssueGithubSyncBodySchema>;
    try {
      body = IssueGithubSyncBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.issueService.setGithubSync(principal.workspace, req.params.id, body, {
          subject: principal.subject,
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not an imported copy → 400
    }
  });

  // Detach the remote link; the local issue and its whole history stay.
  app.delete<{ Params: { id: string } }>(
    "/issues/:id/github",
    { schema: issueGithubDocs.detach },
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
      try {
        const agent = agentAttributionFrom(req.headers);
        return reply.send(
          await deps.issueService.detachGithub(principal.workspace, req.params.id, {
            subject: principal.subject,
            ...(agent ? { agent } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
