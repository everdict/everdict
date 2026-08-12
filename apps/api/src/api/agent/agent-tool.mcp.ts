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
      annotations: { readOnlyHint: true },
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
      // NOT a read: durable self-modification — changes which tools the agent holds. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
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
    "get_agent_tool",
    {
      annotations: { readOnlyHint: true },
      description:
        "ONE tool of YOUR toolset in full: which channel put it there (builtin | capability | mcpServer), how it is " +
        "reached (remote MCP URL · stdio container · code script), the functions it contributes with the NAMESPACED " +
        "names you actually call, the pinned source + worked examples of a code tool, and each declared secret with " +
        "the secret name it reads and whether it resolves for this member. Use it to explain a tool, to debug 'why " +
        "isn't this tool working', or before editing the capability behind it. Unknown key → NOT_FOUND.",
      inputSchema: { key: z.string().describe("Key from list_agent_tools") },
    },
    ({ key }) => run(principal, "agents:read", async () => ok(await tooling.getTool(ws, principal.subject, key))),
  );

  server.registerTool(
    "probe_agent_tool",
    {
      // NOT a read: outbound connect carrying the member's resolved secret. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
      description:
        "Test-connect one MCP tool with the secret THIS member's agent would use and list what the server really " +
        "serves — the live answer to 'what functions does this tool have' and the first check when a tool misbehaves. " +
        "A failure is a result (reachable:false + reason + unresolved secret names), never an error. Only a remote " +
        "(HTTP) MCP tool is probeable; a container tool or a code tool is BAD_REQUEST (verify a code tool by running it).",
      inputSchema: { key: z.string().describe("Key from list_agent_tools") },
    },
    ({ key }) => run(principal, "agents:read", async () => ok(await tooling.probeTool(ws, principal.subject, key))),
  );

  server.registerTool(
    "bind_agent_tool_secrets",
    {
      annotations: { readOnlyHint: false },
      description:
        "Point one tool's declared secrets at real secret names in this workspace (names only — never values). This " +
        "edits the WORKSPACE agent configuration, since that is where the binding lives (an adopted capability's " +
        "pinned reference / a hand-wired server's authSecret / the spec-level overlay for a built-in default or a " +
        "published-but-unadopted capability), so it needs agents:write and cuts a new agent version. Omitted " +
        "entries keep their current binding; an empty name clears the remap (back to the declared name).",
      inputSchema: {
        key: z.string().describe("Key from list_agent_tools"),
        bindings: z.record(z.string()).describe("Declared secret name → the secret name it should read"),
      },
    },
    ({ key, bindings }) =>
      run(principal, "agents:write", async () =>
        ok(await tooling.bindToolSecrets(ws, principal.subject, key, bindings)),
      ),
  );

  server.registerTool(
    "list_agent_skills",
    {
      annotations: { readOnlyHint: true },
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
      // NOT a read: durable self-modification — changes which skills the agent follows. The authz action (:read) says who may CALL, never what it DOES.
      annotations: { readOnlyHint: false },
      description:
        "Turn one skill on or off FOR THE CALLING MEMBER (enabled true/false), or pass null to follow the workspace " +
        "default again. The workspace's skill library is untouched — this only changes which procedures the caller's " +
        "agent follows. Returns the refreshed list.",
      inputSchema: setInput,
    },
    ({ key, enabled }) =>
      run(principal, "agents:read", async () => ok(await tooling.setSkill(ws, principal.subject, key, enabled))),
  );

  server.registerTool(
    "get_agent_model",
    {
      annotations: { readOnlyHint: true },
      description:
        "Which registered model YOUR conversations run on by default, beside the workspace baseline it stands in " +
        "for: `model` is the calling member's own pick (null = they follow the workspace) and `workspaceDefault` is " +
        "the workspace agent's model (null = the deployment default). Use list_models for what may be picked.",
      inputSchema: {},
    },
    () => run(principal, "agents:read", async () => ok(await tooling.getModel(ws, principal.subject))),
  );

  server.registerTool(
    "set_agent_model",
    {
      // NOT a read: durable self-modification — changes which model the member's future conversations think with.
      annotations: { readOnlyHint: false },
      description:
        "Set the default model FOR THE CALLING MEMBER's conversations (a registered model id from list_models), or " +
        "pass null to follow the workspace agent's model again. The workspace's agent configuration is untouched, a " +
        "single conversation's own pick still wins over this, and a crafted agent keeps the model it declares. An " +
        "unregistered id is NOT_FOUND. Returns the refreshed preference.",
      inputSchema: {
        model: z.string().nullable().describe("Registered model id · null = follow the workspace default"),
      },
    },
    ({ model }) => run(principal, "agents:read", async () => ok(await tooling.setModel(ws, principal.subject, model))),
  );
}
