import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// GitHub App MCP tools — the MCP twin of github-app.routes.ts.
export function registerGithubAppTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation. settings:read/write.
  if (deps.githubAppService) {
    const gh = deps.githubAppService;
    server.registerTool(
      "list_workspace_github_app",
      {
        description:
          "This workspace's GitHub App integration — GHE App registrations + workspace-owned installations (host/installationId/account + allowed repos) + the callbackUrl to register as the App Setup URL. No secret values.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const view = await gh.viewWithRepos(ws);
          const callbackUrl = gh.callbackUrl();
          return ok({ ...view, ...(callbackUrl !== undefined ? { callbackUrl } : {}) });
        }),
    );
    server.registerTool(
      "start_workspace_github_app_install",
      {
        description:
          "Start a GitHub App install (admin) → returns the GitHub installation-page URL (admin opens it and selects repos). host unset=github.com (env App), set=a registered GHE App.",
        inputSchema: { host: z.string().url().optional().describe("GHE base URL (unset=github.com)") },
      },
      ({ host }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.startInstall({ workspace: ws, createdBy: principal.subject, ...(host ? { host } : {}) })),
        ),
    );
    server.registerTool(
      "register_workspace_github_app",
      {
        description:
          "Register/update a GHE App (admin). Upsert by host. Put the App private key (PEM) in the SecretStore first and pass its name as privateKeySecretName.",
        inputSchema: {
          host: z.string().url().describe("GHE base URL"),
          slug: z.string().min(1).describe("App slug (used in the install URL)"),
          appId: z.string().min(1).describe("GitHub App ID"),
          privateKeySecretName: z.string().min(1).describe("SecretStore key name holding the App private key (PEM)"),
        },
      },
      ({ host, slug, appId, privateKeySecretName }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.registerGheApp(ws, { host, slug, appId, privateKeySecretName })),
        ),
    );
    server.registerTool(
      "remove_workspace_github_app_registration",
      {
        description:
          "Unregister a GHE App (admin). Existing installation records remain but no token can be minted without credentials.",
        inputSchema: { host: z.string().url().describe("GHE base URL") },
      },
      ({ host }) => run(principal, "settings:write", async () => ok(await gh.removeRegistration(ws, host))),
    );
    server.registerTool(
      "unlink_workspace_github_app_installation",
      {
        description:
          "Unlink an installation (admin). The actual uninstall happens on GitHub — here we just forget the record (idempotent).",
        inputSchema: { installationId: z.number().int().describe("GitHub installation id") },
      },
      ({ installationId }) =>
        run(principal, "settings:write", async () => ok(await gh.unlinkInstallation(ws, installationId))),
    );
  }
}
