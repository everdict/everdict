import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseUrl } from "../route-context.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// workspace-owned GitHub App integration — org install → selected repos → workspace-owned installation tokens (github.com + GHE registrations).
export function registerGithubAppRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation ---
  // Read settings:read / install·register·unlink settings:write. The callback is a public route GitHub calls (no auth, verified via state).
  app.get("/workspace/github-app", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      // Install status + each installation's allowed repos (soft-fail) — the settings screen shows "installed + what's allowed".
      const view = await deps.githubAppService.viewWithRepos(principal.workspace);
      const callbackUrl = deps.githubAppService.callbackUrl(baseUrl(req)); // the value to register as the App Setup URL (for display)
      return reply.send({ ...view, ...(callbackUrl !== undefined ? { callbackUrl } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // repo picker — the repos the workspace App installation can access (only those chosen at install). For the CI repo-link UX. settings:read.
  app.get("/workspace/github-app/repos", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:read");
      return reply.send(await deps.githubAppService.listRepos(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/workspace/github-app/install/start", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z.object({ host: z.string().url().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const out = await deps.githubAppService.startInstall({
        workspace: principal.workspace,
        createdBy: principal.subject,
        ...(body.data.host !== undefined ? { host: body.data.host } : {}),
      });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Public callback — GitHub redirects to the Setup URL after App install (installation_id + setup_action + state).
  app.get("/workspace/github-app/callback", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const q = z
      .object({ installation_id: z.coerce.number().int().optional(), state: z.string().optional() })
      .parse(req.query ?? {});
    const { redirectTo } = await deps.githubAppService.callback({
      ...(q.installation_id !== undefined ? { installationId: q.installation_id } : {}),
      ...(q.state !== undefined ? { state: q.state } : {}),
    });
    return reply.redirect(redirectTo);
  });

  app.post("/workspace/github-app/registrations", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        host: z.string().url(),
        slug: z.string().min(1),
        appId: z.string().min(1),
        privateKeySecretName: z.string().min(1),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.registerGheApp(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/github-app/registrations", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = z.object({ host: z.string().url() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(q.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.removeRegistration(principal.workspace, q.data.host));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/workspace/github-app/installations/:id", async (req, reply) => {
    if (!deps.githubAppService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "github app service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const id = z.coerce.number().int().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ code: "BAD_REQUEST", message: "installation id is not a number" });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.githubAppService.unlinkInstallation(principal.workspace, id.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
