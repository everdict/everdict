import {
  type McpInvoke,
  type SkillEntry,
  type ToolDefinition,
  ToolRegistry,
  buildSkillTool,
  buildToolSearchTool,
  mcpToolToDefinition,
} from "@everdict/agent-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CodeToolRuntime, type ResolvedCodeTool, buildCodeTools } from "./code-tools.js";
import { type ForwardHeaders, forwardHeaderRecord } from "./principal.js";

// Read-only allowlist by verb prefix — default-deny. Only these read/preview verbs from the control-plane MCP surface
// are bridged; mutating tools (run_/create_/set_/delete_/control_/…) are excluded. Applies to the BUILT-IN everdict
// surface always, and to a workspace MCP server UNLESS that server was registered write-allowed (opt-in).
const READ_PREFIXES = ["get_", "list_", "inspect_", "diff_", "estimate_", "leaderboard_", "search_", "hf_", "preview_"];

function isReadOnlyToolName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

// Curated "use the integration" ACTION tools from the control-plane surface, exposed to the agent BY DEFAULT (beyond
// the read verbs) so a workspace's configured integrations (Mattermost / CI / image registry) are usable without an
// admin hand-registering a write-allowed MCP server. Kept deliberately narrow: only genuine use-the-integration
// actions — NOT config/register/destroy (set_/probe_/remove_/assign_/link_/unlink_/start_) and NOT secret writes.
// Each is bridged as isReadOnly:false so the agent's HITL permission gate approves every call inline. This is an
// explicit allowlist, so default-deny still holds for every other mutating verb on the base surface.
const INTEGRATION_ACTIONS = new Set<string>([
  "post_mattermost_message",
  "open_ci_setup_pr",
  "get_image_push_credentials",
]);

// A base (built-in everdict) tool reaches the agent if it is a read verb OR one of the curated integration actions.
export function isDefaultBaseTool(name: string): boolean {
  return isReadOnlyToolName(name) || INTEGRATION_ACTIONS.has(name);
}

// A base tool is read-only (skips the HITL gate) only when it is a pure read verb AND not a curated integration
// action — so an action like get_image_push_credentials (matches get_ but MINTS credentials) is still HITL-gated.
export function isBaseToolReadOnly(name: string): boolean {
  return isReadOnlyToolName(name) && !INTEGRATION_ACTIONS.has(name);
}

// A workspace-registered MCP tool server (from the workspace's AgentSpec), with its authSecret already resolved to a
// verbatim Authorization header value. write=true → all of its tools are bridged (mutating allowed); else read-only subset.
export interface ResolvedMcpServer {
  name: string;
  url: string;
  authorization?: string; // verbatim `Authorization` header value (e.g. "Bearer …") resolved from the server's authSecret
  write: boolean;
}

export interface ToolSession {
  registry: ToolRegistry;
  // Direct read-tool invocation for @-reference resolution (get_*) — always the BASE everdict client (its read tools
  // resolve workspace entities); null when no base MCP session is available.
  call: McpInvoke | null;
  close: () => Promise<void>;
}

// Given the caller's forward headers (and the workspace's extra MCP servers + skills), produce the tool registry for
// one chat turn: connect to the control plane's MCP as that principal + each workspace server, bridge the allowed
// tools (deferred), add ToolSearch, and add the native `use_skill` tool for the workspace's skills.
export type ToolProvider = (
  headers: ForwardHeaders,
  extraServers?: ResolvedMcpServer[],
  skills?: SkillEntry[],
  codeTools?: ResolvedCodeTool[],
) => Promise<ToolSession>;

const EMPTY_SESSION: ToolSession = { registry: new ToolRegistry([]), call: null, close: async () => {} };

// One MCP call → ToolResult, bound to a specific client. An MCP result is a content-block array — join the text blocks
// and carry any image blocks through as base64 (the kernel surfaces them to the model as multimodal content).
function makeInvoke(client: Client, prefix?: string): McpInvoke {
  return async (name, args) => {
    // A namespaced workspace tool is exposed to the model as `mcp__<server>__<tool>`; strip the prefix before calling
    // the server, which only knows the bare tool name.
    const toolName = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const r = await client.callTool({ name: toolName, arguments: args });
    const blocks =
      (r.content as Array<{ type?: string; text?: string; data?: string; mimeType?: string }> | undefined) ?? [];
    const text = blocks
      .filter((b) => typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    const images = blocks
      .filter((b) => b.type === "image" && typeof b.data === "string")
      .map((b) => ({ data: b.data as string, mediaType: b.mimeType ?? "image/png" }));
    return { content: text, isError: r.isError === true, ...(images.length > 0 ? { images } : {}) };
  };
}

export function mcpToolProvider(mcpUrl: string, codeRuntime?: CodeToolRuntime): ToolProvider {
  const baseUrl = new URL(mcpUrl);
  return async (headers, extraServers = [], skills = [], codeTools = []) => {
    const clients: Client[] = [];
    const bridged: ToolDefinition[] = [];
    let baseCall: McpInvoke | null = null;

    // 1. Base everdict MCP — read verbs + the curated integration actions, forwarding the caller's bearer (dogfooding
    // the control plane's own tools). The integration actions are bridged isReadOnly:false so each call is HITL-gated.
    const baseClient = new Client({ name: "everdict-agent", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: forwardHeaderRecord(headers) },
      });
      await baseClient.connect(transport);
      const baseTools = (await baseClient.listTools()).tools.filter((t) => isDefaultBaseTool(t.name));
      if (baseTools.length > 0) {
        clients.push(baseClient);
        const invoke = makeInvoke(baseClient);
        baseCall = invoke;
        for (const t of baseTools) {
          bridged.push(
            mcpToolToDefinition(
              {
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: isBaseToolReadOnly(t.name) },
            ),
          );
        }
      } else {
        await baseClient.close().catch(() => {});
      }
    } catch {
      // Degrade rather than fail: the agent answers from its own knowledge when the platform tools are unreachable.
      await baseClient.close().catch(() => {});
    }

    // 2. Each workspace-registered MCP server — its OWN authorization; read-only unless registered write-allowed. Its
    // tools are NAMESPACED `mcp__<server>__<tool>` so multiple servers (and the built-in tools) can't collide, and the
    // model can see which server a tool belongs to. The invoke strips the prefix before calling the server.
    for (const server of extraServers) {
      const client = new Client({ name: "everdict-agent", version: "0.1.0" });
      try {
        const requestHeaders: Record<string, string> = server.authorization
          ? { authorization: server.authorization }
          : {};
        const transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: requestHeaders },
        });
        await client.connect(transport);
        const prefix = `mcp__${server.name.replace(/[^a-zA-Z0-9_]/g, "_")}__`;
        const listed = (await client.listTools()).tools;
        const allowed = server.write ? listed : listed.filter((t) => isReadOnlyToolName(t.name));
        const invoke = makeInvoke(client, prefix);
        const toAdd: ToolDefinition[] = [];
        for (const t of allowed) {
          const name = `${prefix}${t.name}`;
          if (bridged.some((b) => b.name === name) || toAdd.some((b) => b.name === name)) continue;
          toAdd.push(
            mcpToolToDefinition(
              {
                name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: !server.write },
            ),
          );
        }
        if (toAdd.length === 0) {
          await client.close().catch(() => {});
          continue;
        }
        clients.push(client);
        bridged.push(...toAdd);
      } catch {
        await client.close().catch(() => {}); // an unreachable workspace server is skipped, not fatal
      }
    }

    // Deterministic tool order (name-sorted) so ToolSearch results + the outbound tools[] are stable across runs.
    bridged.sort((a, b) => a.name.localeCompare(b.name));

    // The native `use_skill` tool (progressive disclosure over the workspace's skills) is added even when no MCP tools
    // are reachable — a workspace can rely on skills alone.
    const skillTool = buildSkillTool(skills);
    // Adopted code capabilities → native `code__<name>` tools. buildCodeTools drops any adopted-from-others code the
    // runtime can't safely (isolatedly) run — never execute untrusted code on the host.
    const { defs: codeDefs } = buildCodeTools(codeTools, codeRuntime);
    if (bridged.length === 0 && !skillTool && codeDefs.length === 0) return EMPTY_SESSION;

    const tools: ToolDefinition[] = [];
    if (bridged.length > 0) tools.push(buildToolSearchTool(new ToolRegistry(bridged)), ...bridged);
    tools.push(...codeDefs); // native code tools — always loaded (not deferred behind ToolSearch)
    if (skillTool) tools.push(skillTool);
    const registry = new ToolRegistry(tools);
    return {
      registry,
      call: baseCall,
      close: async () => {
        for (const c of clients) await c.close().catch(() => {});
      },
    };
  };
}
