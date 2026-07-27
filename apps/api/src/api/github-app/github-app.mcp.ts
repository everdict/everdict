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
          "This workspace's GitHub App integration — workspace-owned installations (host/installationId/account + allowed repos), the configured providers (github.com / GitHub Enterprise, both operator env), and the callbackUrl to register as the App Setup URL. No secret values.",
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
          "Start a GitHub App install (admin) → returns the GitHub installation-page URL (admin opens it and selects repos). host unset=github.com (env App), set=the GitHub Enterprise host (env App). Both providers are operator env — no per-workspace App registration.",
        inputSchema: {
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset=github.com)"),
        },
      },
      ({ host }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.startInstall({ workspace: ws, createdBy: principal.subject, ...(host ? { host } : {}) })),
        ),
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
    server.registerTool(
      "list_github_issues",
      {
        description:
          "List issues and pull requests in a repository the workspace's GitHub App is installed on (most-recently-updated first): number, title, state, author, URL, and whether each is a PR. Use to triage or find an item to read.",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          state: z.enum(["open", "closed", "all"]).optional().describe("state filter (default open)"),
          limit: z.number().int().positive().max(100).optional().describe("max rows (default 30, max 100)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, state, limit, host }) =>
        run(principal, "settings:read", async () =>
          ok({
            issues: await gh.listRepoIssues(
              ws,
              repository,
              { ...(state ? { state } : {}), ...(limit !== undefined ? { limit } : {}) },
              host,
            ),
          }),
        ),
    );
    server.registerTool(
      "get_github_file",
      {
        description:
          "Read a text file from a repository the workspace's GitHub App is installed on — returns its UTF-8 content, sha, and size. Use to inspect code or config referenced in a task.",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          path: z.string().min(1).describe("file path within the repo"),
          ref: z.string().optional().describe("branch, tag, or sha (default: the repo's default branch)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, path, ref, host }) =>
        run(principal, "settings:read", async () => ok(await gh.getRepoFile(ws, repository, path, ref, host))),
    );
  }
}
