import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of the tracker's GitHub import + manual sync (BFF↔MCP parity). Everdict is the client: nothing here
// runs on a timer, so an agent asked to "catch up with GitHub" calls pull_github_issues explicitly.
export function registerIssueGithubTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.issueSync) return;
  const sync = deps.issueSync;
  const agent = ctx.agent?.agentId
    ? {
        agentId: ctx.agent.agentId,
        ...(ctx.agent.conversationId !== undefined ? { conversationId: ctx.agent.conversationId } : {}),
      }
    : undefined;
  const actor = { subject: principal.subject, ...(agent ? { agent } : {}) };

  server.registerTool(
    "list_github_import_candidates",
    {
      description:
        "GitHub issues in a repo that this workspace has NOT imported yet (pull requests excluded). Call this " +
        "before import_github_issues to see what is available and to avoid asking for numbers that already exist " +
        "here. Reads through the workspace GitHub App, so the App must be installed on the repo.",
      inputSchema: {
        repository: z.string().describe('"owner/name"'),
        host: z.string().optional().describe("GitHub Enterprise host; omit for github.com"),
        state: z.enum(["open", "closed", "all"]).optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await sync.importCandidates(ws, {
            repository: a.repository,
            ...(a.host !== undefined ? { host: a.host } : {}),
            ...(a.state !== undefined ? { state: a.state } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "import_github_issues",
    {
      description:
        "Copy GitHub issues into the workspace tracker so their evaluation can be tracked here. Idempotent — a " +
        "number already imported is skipped, not duplicated. An open issue lands as `todo`; a closed one lands as " +
        "`done` with a note and NO scorecard (do not invent evidence: the resolution scorecard is what later " +
        "regression checks compare against). sync.push defaults to false; only enable it when the workspace wants " +
        "everdict to close/reopen the GitHub issue.",
      inputSchema: {
        repository: z.string(),
        numbers: z.array(z.number().int().positive()).min(1).max(100),
        host: z.string().optional(),
        projectId: z.string().optional().describe("file the imported issues under this project"),
        sync: z.object({ pull: z.boolean(), push: z.boolean() }).optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await sync.import(
            ws,
            {
              repository: a.repository,
              numbers: a.numbers,
              ...(a.host !== undefined ? { host: a.host } : {}),
              ...(a.projectId !== undefined ? { projectId: a.projectId } : {}),
              ...(a.sync !== undefined ? { sync: a.sync } : {}),
            },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "pull_github_issues",
    {
      description:
        "Refresh a repo's imported issues from GitHub in one incremental call. GitHub wins on title, description, " +
        "labels and comments; a remote close/reopen reconciles through the normal transitions, so it emits the " +
        "same facts a member's move would. Nothing polls on a timer — call this when you need the copies current.",
      inputSchema: { repository: z.string(), host: z.string().optional() },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await sync.pullRepository(
            ws,
            { repository: a.repository, ...(a.host !== undefined ? { host: a.host } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "sync_github_issue",
    {
      description:
        "Refresh one imported issue from GitHub. A remote unchanged since the last pull is a no-op (the same " +
        "watermark that stops our own push from echoing back).",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:write", async () => ok(await sync.pullIssue(ws, a.id, actor))),
  );

  server.registerTool(
    "set_issue_github_sync",
    {
      description:
        "Turn pull/push on or off for an imported issue. Enabling push means resolving or reopening the issue " +
        "here will close or reopen the GitHub issue and post an explanatory comment — a visible action in " +
        "someone else's tracker, so only do it when asked.",
      inputSchema: { id: z.string(), pull: z.boolean(), push: z.boolean() },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(await sync.setSync(ws, a.id, { pull: a.pull, push: a.push }, actor)),
      ),
  );

  server.registerTool(
    "get_github_issue_attachment",
    {
      description:
        "The image behind an attachment URL in an imported issue's description or comments. An imported body is " +
        "the remote's own markdown, so a screenshot in it is a GitHub URL that nothing outside GitHub can read — " +
        "on Enterprise, and on any private repository, it needs the workspace App's installation. Call this with " +
        "a URL copied verbatim from the body when the picture is what the issue is actually about; a URL on any " +
        "other host is refused. Returns the image itself, not a link.",
      inputSchema: {
        id: z.string().describe("the everdict issue id (an imported copy)"),
        url: z.string().describe("attachment URL exactly as it appears in the body"),
      },
    },
    (a) =>
      run(principal, "issues:read", async () => {
        const asset = await sync.fetchAttachment(ws, a.id, a.url);
        // An image content block, not JSON: handing the model a base64 blob inside a text envelope would make it
        // unreadable by the very thing that can look at it.
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(asset.bytes).toString("base64"),
              mimeType: asset.contentType,
            },
          ],
        };
      }),
  );
}
