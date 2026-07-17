import { NotFoundError } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

// Interactive browser sessions over MCP — BFF↔MCP parity with browser-session.routes.ts. Personal / self-scoped
// (owner = principal.subject): no role gate; the service enforces owner-only.
export function registerBrowserSessionTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;
  if (!deps.browserSessionService) return;
  const sessions = deps.browserSessionService;

  server.registerTool(
    "start_browser_session",
    {
      description:
        "Start an interactive browser session (a dedicated browser for profile login) — provisions a browser " +
        "and returns its handle. At most one active session per owner (an existing one is closed first).",
      inputSchema: {},
    },
    () => plain(async () => ok(await sessions.create({ tenant: principal.workspace, createdBy: principal.subject }))),
  );

  server.registerTool(
    "list_browser_sessions",
    {
      description: "List my interactive browser sessions (self-scoped).",
      inputSchema: {},
    },
    () => plain(async () => ok({ sessions: sessions.list(principal.subject) })),
  );

  server.registerTool(
    "get_browser_session",
    {
      description: "Get one of my interactive browser sessions by id.",
      inputSchema: { id: z.string().describe("Browser session id") },
    },
    ({ id }) =>
      plain(async () => {
        const session = sessions.get(id, principal.subject);
        if (!session) throw new NotFoundError("NOT_FOUND", { id }, "browser session not found.");
        return ok(session);
      }),
  );

  server.registerTool(
    "close_browser_session",
    {
      description: "Close an interactive browser session (tears the browser down). Owner-only.",
      inputSchema: { id: z.string().describe("Browser session id") },
    },
    ({ id }) =>
      plain(async () => {
        await sessions.close(id, principal.subject);
        return ok({ ok: true });
      }),
  );

  server.registerTool(
    "preview_browser_session_state",
    {
      description:
        "Preview what capturing this browser session would remember — the browser's current cookies summarized " +
        "per domain (names only; cookie values never cross the wire). Poll it while logging into sites to see " +
        "which logins a profile capture would save. Owner-only.",
      inputSchema: { id: z.string().describe("Browser session id") },
    },
    ({ id }) => plain(async () => ok(await sessions.statePreview(id, principal.subject))),
  );

  if (deps.browserTickets) {
    const tickets = deps.browserTickets;
    server.registerTool(
      "browser_session_ticket",
      {
        description:
          "Mint a short-lived single-use WebSocket ticket for a browser session (owner-only). The client opens " +
          "WS /browser-sessions/:id?ticket=… to stream the screencast and send input.",
        inputSchema: { id: z.string().describe("Browser session id") },
      },
      ({ id }) =>
        plain(async () => {
          if (sessions.ownerOf(id) !== principal.subject)
            throw new NotFoundError("NOT_FOUND", { id }, "browser session not found.");
          return ok({ ticket: tickets.issue(id, principal.subject) });
        }),
    );
  }
}
