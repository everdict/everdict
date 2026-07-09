import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// CI-link MCP tools — the MCP twin of ci-link.routes.ts.
export function registerCiLinkTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // CI repo links — repository↔harness slot mapping (= GitHub Actions OIDC trust policy) + picker + setup-PR.
  if (deps.ciLinkService) {
    const ci = deps.ciLinkService;
    server.registerTool(
      "list_ci_links",
      { description: "This workspace's CI repo links (repo↔harness slot mapping = OIDC trust)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok({ links: await ci.list(ws) })),
    );
    server.registerTool(
      "link_ci_repository",
      {
        description:
          "Register/update a CI repo link (admin) — the link's existence trusts that repo's GitHub Actions OIDC token into this workspace (keyless CI).",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe('GHE base URL (e.g. "https://ghe.acme.io") — unset = github.com'),
          harness: z.string().describe("harness instance id"),
          dataset: z.string().optional().describe("dataset id the CI fires (used in the setup-PR workflow)"),
          slots: z
            .record(z.object({ path: z.string().optional() }))
            .optional()
            .describe("service slot → monorepo path (optional) — the slots this repo's CI swaps"),
          runsOn: z
            .string()
            .optional()
            .describe(
              'narrowing override — workflow runs-on (default "[self-hosted]", e.g. "[self-hosted, everdict-<id>]")',
            ),
          runtime: z
            .string()
            .optional()
            .describe(
              'narrowing override — run-eval runtime (default "self:ws" workspace runner pool, e.g. "self:ws:<id>"). Personal runners (self…) → 400',
            ),
          trigger: z
            .enum(["auto", "comment", "both"])
            .optional()
            .describe(
              "how PR evaluation is triggered (optional) — auto=only automatic on PR events, comment=only the /evaluate PR comment (on-demand), both(default)=both",
            ),
        },
      },
      ({ repository, host, harness, dataset, slots, runsOn, runtime, trigger }) =>
        run(principal, "settings:write", async () =>
          ok({
            links: await ci.upsert(ws, principal.subject, {
              repository,
              harness,
              slots: slots ?? {},
              ...(host !== undefined ? { host } : {}),
              ...(dataset !== undefined ? { dataset } : {}),
              ...(runsOn !== undefined ? { runsOn } : {}),
              ...(runtime !== undefined ? { runtime } : {}),
              ...(trigger !== undefined ? { trigger } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "unlink_ci_repository",
      {
        description: "Remove a CI repo link (admin) — that repo's OIDC trust is severed too.",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe("GHE base URL — unset = github.com link"),
        },
      },
      ({ repository, host }) =>
        run(principal, "settings:write", async () => ok({ links: await ci.remove(ws, repository, host) })),
    );
    server.registerTool(
      "list_github_app_repos",
      {
        description:
          "Repos accessible to the workspace's GitHub App installation (picker) — only those chosen at install time. settings:read.",
        inputSchema: {},
      },
      () => run(principal, "settings:read", async () => ok(await ci.listRepos(ws))),
    );
    server.registerTool(
      "open_ci_setup_pr",
      {
        description:
          "Synthesize the Everdict eval workflow YAML in a linked repo and open a setup-PR (workspace GitHub App token). Merging it activates CI eval. The workflow always targets self-hosted runners — 400 if the self:ws pool has no shared runner (register one first via github_install_workspace_runner).",
        inputSchema: {
          repository: z.string().describe('"owner/name"'),
          host: z.string().url().optional().describe("GHE base URL — unset = github.com link"),
        },
      },
      ({ repository, host }) =>
        run(principal, "harnesses:read", async () =>
          ok(await ci.openSetupPr(ws, repository, host !== undefined ? { host } : {})),
        ),
    );
  }
}
