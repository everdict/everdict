import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Agent tool/skill MCP tools — the MCP twin of agent-tool.routes.ts. Self-scoped to the CALLING principal: an agent
// asking "what do I have" gets what the member it is acting for configured, not a workspace-wide list.
export function registerAgentToolTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.agentMemberToolingService) return;
  const tooling = deps.agentMemberToolingService;
  const setInput = {
    key: z.string().describe("Key from list_agent_tools / list_agent_skills"),
    enabled: z.boolean().nullable().describe("true = on · false = off · null = follow the workspace default"),
  };

  server.registerTool(
    "list_agent_tools",
    {
      description:
        "The tools available to YOUR agent in this workspace, each with its scope (builtin | workspace | personal), " +
        "whether it is on for you (enabled), and what the workspace baseline is. Includes tools you have not switched " +
        "on yet, so it is also the discovery surface for 'what else could I use'.",
      inputSchema: {},
    },
    // Self-scoped read (the caller's own configuration), like personal secrets — membership is the gate.
    () => run(principal, "agents:read", async () => ok(await tooling.listTools(ws, principal.subject))),
  );

  server.registerTool(
    "set_agent_tool",
    {
      description:
        "Turn one tool on or off FOR THE CALLING MEMBER (enabled true/false), or pass null to follow the workspace " +
        "default again. The workspace's agent configuration is untouched — this only changes the caller's own " +
        "toolset. Returns the refreshed list.",
      inputSchema: setInput,
    },
    ({ key, enabled }) =>
      run(principal, "agents:read", async () => ok(await tooling.setTool(ws, principal.subject, key, enabled))),
  );

  server.registerTool(
    "list_agent_skills",
    {
      description:
        "The skills YOUR agent follows in this workspace — authored skills, adopted/published packages and the " +
        "built-ins — each with its scope, whether it is on for you, and the workspace baseline. The workspace " +
        "library says which skills exist; this says which ones you actually run with.",
      inputSchema: {},
    },
    () => run(principal, "agents:read", async () => ok(await tooling.listSkills(ws, principal.subject))),
  );

  server.registerTool(
    "set_agent_skill",
    {
      description:
        "Turn one skill on or off FOR THE CALLING MEMBER (enabled true/false), or pass null to follow the workspace " +
        "default again. The workspace's skill library is untouched — this only changes which procedures the caller's " +
        "agent follows. Returns the refreshed list.",
      inputSchema: setInput,
    },
    ({ key, enabled }) =>
      run(principal, "agents:read", async () => ok(await tooling.setSkill(ws, principal.subject, key, enabled))),
  );
}
