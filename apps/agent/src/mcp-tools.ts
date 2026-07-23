import {
  type McpInvoke,
  type ToolDefinition,
  ToolRegistry,
  buildToolSearchTool,
  mcpToolToDefinition,
} from "@everdict/agent-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ForwardHeaders, forwardHeaderRecord } from "./principal.js";

// Read-only allowlist by verb prefix — default-deny. Only these read/preview verbs from the control-plane MCP surface
// are bridged; mutating tools (run_/create_/set_/delete_/control_/…) are excluded. Applies to the BUILT-IN everdict
// surface always, and to a workspace MCP server UNLESS that server was registered write-allowed (opt-in).
const READ_PREFIXES = ["get_", "list_", "inspect_", "diff_", "estimate_", "leaderboard_", "search_", "hf_", "preview_"];

function isReadOnlyToolName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
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

// Given the caller's forward headers (and the workspace's extra MCP servers), produce the tool registry for one chat
// turn: connect to the control plane's MCP as that principal + each workspace server, bridge the allowed tools
// (deferred), and add ToolSearch.
export type ToolProvider = (headers: ForwardHeaders, extraServers?: ResolvedMcpServer[]) => Promise<ToolSession>;

const EMPTY_SESSION: ToolSession = { registry: new ToolRegistry([]), call: null, close: async () => {} };

// One MCP call → ToolResult, bound to a specific client.
function makeInvoke(client: Client): McpInvoke {
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
    return { content: text, isError: r.isError === true };
  };
}

export function mcpToolProvider(mcpUrl: string): ToolProvider {
  const baseUrl = new URL(mcpUrl);
  return async (headers, extraServers = []) => {
    const clients: Client[] = [];
    const bridged: ToolDefinition[] = [];
    let baseCall: McpInvoke | null = null;

    // 1. Base everdict MCP — read-only, forwarding the caller's bearer (dogfooding the control plane's own tools).
    const baseClient = new Client({ name: "everdict-agent", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: forwardHeaderRecord(headers) },
      });
      await baseClient.connect(transport);
      const readTools = (await baseClient.listTools()).tools.filter((t) => isReadOnlyToolName(t.name));
      if (readTools.length > 0) {
        clients.push(baseClient);
        const invoke = makeInvoke(baseClient);
        baseCall = invoke;
        for (const t of readTools) {
          bridged.push(
            mcpToolToDefinition(
              {
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
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

    // 2. Each workspace-registered MCP server — its OWN authorization; read-only unless registered write-allowed.
    // Existing bridged names win on collision (base everdict tools are never shadowed by a workspace server).
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
        const listed = (await client.listTools()).tools;
        const tools = server.write ? listed : listed.filter((t) => isReadOnlyToolName(t.name));
        const fresh = tools.filter((t) => !bridged.some((b) => b.name === t.name)); // don't shadow already-bridged names
        if (fresh.length === 0) {
          await client.close().catch(() => {});
          continue;
        }
        clients.push(client);
        const invoke = makeInvoke(client);
        for (const t of fresh) {
          bridged.push(
            mcpToolToDefinition(
              {
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: !server.write },
            ),
          );
        }
      } catch {
        await client.close().catch(() => {}); // an unreachable workspace server is skipped, not fatal
      }
    }

    if (bridged.length === 0) return EMPTY_SESSION;
    const bridgedRegistry = new ToolRegistry(bridged);
    const registry = new ToolRegistry([buildToolSearchTool(bridgedRegistry), ...bridged]);
    return {
      registry,
      call: baseCall,
      close: async () => {
        for (const c of clients) await c.close().catch(() => {});
      },
    };
  };
}
