import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installGithubWorkspaceRunner } from "../../core/runner/github-runner-install.js";
import { RUNNER_CAPABILITIES } from "../../core/runner/runner-service.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Workspace-runner MCP tools — the MCP twin of workspace-runner.routes.ts.
export function registerWorkspaceRunnerTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.runnerService) {
    const runners = deps.runnerService;
    // Workspace runner roster — runners paired in this workspace (metadata only). Read-only (members:read). Management is personal (list_runners).
    server.registerTool(
      "list_workspace_runners",
      {
        description: "Roster of self-hosted runners paired in this workspace — metadata only (no tokens)",
        inputSchema: {},
      },
      () => run(principal, "members:read", async () => ok({ runners: await runners.listForWorkspace(ws) })),
    );
    // Workspace-shared runners (team resource, owner=ws:<workspace>) — once an admin registers one, any member can target self:ws:<id>.
    // Unlike personal runners (pair_runner, self-scoped), gated by settings:write (admin).
    server.registerTool(
      "pair_workspace_runner",
      {
        description:
          "Pair a workspace-shared runner (team build server/CI). Any member targets it as self:ws:<id>. The plaintext token (rnr_…) is shown once in the response. Admin only.",
        inputSchema: {
          label: z.string().min(1).max(80).describe("display runner name (e.g. acme-ci-runner)"),
          os: z.string().min(1).max(40).optional().describe("linux | darwin | win32, etc."),
          capabilities: z
            .array(z.enum(RUNNER_CAPABILITIES))
            .optional()
            .describe("what this runner can run (git|docker|browser|computer-use|sandbox|codex-login|claude-login)"),
        },
      },
      ({ label, os, capabilities }) =>
        run(principal, "settings:write", async () => {
          const paired = await runners.pairWorkspace({
            workspace: ws,
            label,
            ...(os !== undefined ? { os } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          });
          return ok({ runner: paired.meta, token: paired.token });
        }),
    );
    server.registerTool(
      "list_workspace_owned_runners",
      {
        description:
          "Only shared runners owned by this workspace (owner=ws:<workspace>) — unlike the roster, excludes personal runners. Admin only.",
        inputSchema: {},
      },
      () => run(principal, "settings:write", async () => ok({ runners: await runners.listWorkspaceOwned(ws) })),
    );
    server.registerTool(
      "revoke_workspace_runner",
      {
        description:
          "Unpair (delete) a workspace-shared runner. id is the id from list_workspace_owned_runners. Admin only.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "settings:write", async () => {
          await runners.revokeWorkspaceRunner(ws, id);
          return ok({ id, revoked: true });
        }),
    );
    // GitHub Actions runner self-registration — installer that stands up a GitHub runner + an Everdict workspace-shared runner together on a build server
    // script generation (design doc §4). Mints a registration token via the workspace GitHub App → only when ciLinkService exists. Admin only.
    if (deps.ciLinkService) {
      const ciForRunner = deps.ciLinkService;
      server.registerTool(
        "github_install_workspace_runner",
        {
          description:
            "Generate an install script that stands up a GitHub Actions self-hosted runner + an Everdict workspace-shared runner together on one build server (design §4). Pairs a new workspace-shared runner (rnr_ token once) + mints a registration token via the workspace GitHub App. Exactly one of repository (repo level) or org (org level) — the App must be installed on that org/repo. Run the returned script on the build server. Admin only.",
          inputSchema: {
            repository: z.string().optional().describe('repo-level target "owner/name"'),
            org: z.string().optional().describe("org-level target (shared by all repos in that org)"),
            host: z.string().url().optional().describe("GHE base URL — unset = github.com matched first"),
            runnerGroup: z
              .string()
              .optional()
              .describe("org runner group (org level only, optional) — applies that group's access policy"),
            label: z.string().max(80).optional().describe("Everdict runner display name (default: repo/org name)"),
            githubLabels: z.array(z.string()).optional().describe("extra labels for the GH runner"),
            capabilities: z.array(z.enum(RUNNER_CAPABILITIES)).optional(),
          },
        },
        ({ repository, org, host, runnerGroup, label, githubLabels, capabilities }) =>
          run(principal, "settings:write", async () =>
            ok(
              await installGithubWorkspaceRunner(
                { runnerService: runners, ciLinkService: ciForRunner },
                {
                  workspace: ws,
                  label: label ?? org ?? repository?.split("/")[1] ?? "everdict-ci",
                  apiUrl: deps.apiPublicUrl ?? "http://localhost:8787",
                  ...(repository !== undefined ? { repository } : {}),
                  ...(org !== undefined ? { org } : {}),
                  ...(host !== undefined ? { host } : {}),
                  ...(runnerGroup !== undefined ? { runnerGroup } : {}),
                  ...(githubLabels !== undefined ? { githubLabels } : {}),
                  ...(capabilities !== undefined ? { capabilities } : {}),
                },
              ),
            ),
          ),
      );
    }
  }
}
