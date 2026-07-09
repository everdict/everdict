import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { installGithubWorkspaceRunner } from "../../core/runner/github-runner-install.js";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES } from "../../core/runner/runner-service.js";
import { baseUrl } from "../route-context.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// workspace-shared runners (team tier self:ws) — roster, pairing, owned list, revoke + GitHub Actions runner self-install.
export function registerWorkspaceRunnerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/workspace/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "members:read");
      return reply.send({ runners: await deps.runnerService.listForWorkspace(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Register a workspace-shared runner (team resource) — an admin pairs it with owner="ws:<workspace>". Unlike a personal runner (POST /runners,
  // self-scoped), any member of this workspace can target it via self:ws:<id> (a team build server/CI runner). Plaintext token only once.
  app.post("/workspace/runners", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = PairRunnerBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write"); // registering a team resource = admin
      const paired = await deps.runnerService.pairWorkspace({
        workspace: principal.workspace,
        label: body.data.label,
        ...(body.data.os !== undefined ? { os: body.data.os } : {}),
        ...(body.data.capabilities !== undefined ? { capabilities: body.data.capabilities } : {}),
      });
      return reply.send({ runner: paired.meta, token: paired.token });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // List workspace-shared runners (owner=ws:<workspace> only — the roster [GET /workspace/runners] includes personal runners, this is team-owned only).
  app.get("/workspace/runners/owned", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      return reply.send({ runners: await deps.runnerService.listWorkspaceOwned(principal.workspace) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Revoke a workspace-shared runner — admin only (owner=ws:<workspace> scope; can't touch personal runners).
  app.delete<{ Params: { id: string } }>("/workspace/runners/:id", async (req, reply) => {
    if (!deps.runnerService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      await deps.runnerService.revokeWorkspaceRunner(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post("/workspace/runners/github-install", async (req, reply) => {
    if (!deps.runnerService || !deps.ciLinkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "runner/ci link service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        repository: z.string().min(1).optional(), // repo-level target "owner/name"
        org: z.string().min(1).optional(), // org-level target. Exactly one of this and repository. The App must be installed on that org/repo.
        host: z.string().url().optional(), // GHE base URL — unset = prefer github.com. Mint via that host's installation.
        runnerGroup: z.string().min(1).optional(), // org runner group (org-level only, optional)
        label: z.string().min(1).max(80).optional(),
        githubLabels: z.array(z.string().min(1)).optional(),
        capabilities: z.array(z.enum(RUNNER_CAPABILITIES)).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    const defaultLabel = body.data.org ?? body.data.repository?.split("/")[1] ?? "everdict-ci";
    try {
      gate(principal, "settings:write");
      return reply.send(
        await installGithubWorkspaceRunner(
          { runnerService: deps.runnerService, ciLinkService: deps.ciLinkService },
          {
            workspace: principal.workspace,
            label: body.data.label ?? defaultLabel,
            apiUrl: baseUrl(req),
            ...(body.data.repository !== undefined ? { repository: body.data.repository } : {}),
            ...(body.data.org !== undefined ? { org: body.data.org } : {}),
            ...(body.data.host !== undefined ? { host: body.data.host } : {}),
            ...(body.data.runnerGroup !== undefined ? { runnerGroup: body.data.runnerGroup } : {}),
            ...(body.data.githubLabels !== undefined ? { githubLabels: body.data.githubLabels } : {}),
            ...(body.data.capabilities !== undefined ? { capabilities: body.data.capabilities } : {}),
          },
        ),
      );
    } catch (err) {
      return sendError(reply, err); // App not installed 404 / repo·org format 400 / GitHub failure 502
    }
  });
}
