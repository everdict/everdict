import { IssueLabelColorSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the issue-label routes (BFF↔MCP parity). An issue carries label IDS, so an agent that wants to
// classify what it filed has to read this list first — which is exactly why the surface exists here and not only
// in the web. Same service, same authz pair as the issue tools (issues:read / issues:write).
export function registerIssueLabelTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.issueLabelService) return;
  const labels = deps.issueLabelService;
  const actor = { subject: principal.subject };

  server.registerTool(
    "list_issue_labels",
    {
      description:
        "List the workspace's issue labels — the vocabulary an issue's labelIds point at. Read this BEFORE " +
        "setting labels on an issue: create_issue/update_issue take label IDS, not names.",
      inputSchema: {},
    },
    async () => run(principal, "issues:read", async () => ok(await labels.list(ws))),
  );

  server.registerTool(
    "create_issue_label",
    {
      description:
        "Define a new issue label. Names are unique per workspace (case-insensitive) — creating one that " +
        "already exists fails, so list_issue_labels first and reuse the id. Colour is a fixed vocabulary.",
      inputSchema: {
        name: z.string().min(1).max(64),
        color: IssueLabelColorSchema,
        description: z.string().max(500).optional(),
      },
    },
    async (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await labels.create(
            {
              tenant: ws,
              name: a.name,
              color: a.color,
              ...(a.description !== undefined ? { description: a.description } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "update_issue_label",
    {
      description:
        "Rename or recolour a label. One write that every issue wearing it sees at once — never edit issues " +
        "one by one to change what a label is called. description:null clears it.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().min(1).max(64).optional(),
        color: IssueLabelColorSchema.optional(),
        description: z.string().max(500).nullable().optional(),
      },
    },
    async (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await labels.update(
            ws,
            a.id,
            {
              ...(a.name !== undefined ? { name: a.name } : {}),
              ...(a.color !== undefined ? { color: a.color } : {}),
              ...(a.description !== undefined ? { description: a.description } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_issue_label",
    {
      description:
        "Delete a label AND strip it off every issue that carries it, in one transaction. Irreversible — call " +
        "issue_label_usage first to see how many issues it comes off.",
      inputSchema: { id: z.string().min(1) },
    },
    async (a) =>
      run(principal, "issues:write", async () => {
        await labels.remove(ws, a.id, actor);
        return ok({ deleted: a.id });
      }),
  );

  server.registerTool(
    "issue_label_usage",
    {
      description: "How many issues currently carry a label — the number to check before deleting it.",
      inputSchema: { id: z.string().min(1) },
    },
    async (a) => run(principal, "issues:read", async () => ok({ issues: await labels.usageCount(ws, a.id) })),
  );
}
