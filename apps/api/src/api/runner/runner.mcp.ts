import { RUNNER_CAPABILITIES } from "@everdict/application-control";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

// Personal runner MCP tools — the MCP twin of runner.routes.ts.
export function registerRunnerTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.runnerService) {
    const runners = deps.runnerService;
    // Self-hosted runners are personally owned (owner=principal.subject) — no role gate, you handle only your own runners (self-scoped, plain, like connections).
    server.registerTool("list_runners", { description: "My self-hosted runners (no tokens)", inputSchema: {} }, () =>
      plain(async () => ok({ runners: await runners.list(principal.subject) })),
    );
    server.registerTool(
      "pair_runner",
      {
        description:
          "Pair a new device as a self-hosted runner. The plaintext token (rnr_…) is shown once in the response and can't be read again — everdict runner authenticates with it.",
        inputSchema: {
          label: z.string().min(1).max(80).describe("display device name (e.g. ho-macbook)"),
          os: z.string().min(1).max(40).optional().describe("linux | darwin | win32, etc."),
          capabilities: z
            .array(z.enum(RUNNER_CAPABILITIES))
            .optional()
            .describe("what this machine can run (git|docker|browser|computer-use|sandbox|codex-login|claude-login)"),
        },
      },
      ({ label, os, capabilities }) =>
        // Personally owned: owner=subject. ws records the paired workspace (roster/visibility).
        plain(async () => {
          const paired = await runners.pair({
            owner: principal.subject,
            workspace: ws,
            label,
            ...(os !== undefined ? { os } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          });
          return ok({ runner: paired.meta, token: paired.token });
        }),
    );
    server.registerTool(
      "revoke_runner",
      {
        description: "Unpair (delete) my self-hosted runner. id is the id from list_runners.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await runners.revoke(principal.subject, id);
          return ok({ id, revoked: true });
        }),
    );
  }
}
