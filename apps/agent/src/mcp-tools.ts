import { type ToolDefinition, ToolRegistry, buildToolSearchTool, mcpToolToDefinition } from "@everdict/agent-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ForwardHeaders, forwardHeaderRecord } from "./principal.js";

// Read-only allowlist by verb prefix — default-deny. Only these read/preview verbs from the control-plane MCP
// surface are bridged in this slice; mutating tools (run_/create_/set_/delete_/control_/…) are excluded.
const READ_PREFIXES = ["get_", "list_", "inspect_", "diff_", "estimate_", "leaderboard_", "search_", "hf_", "preview_"];

function isReadOnlyToolName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

export interface ToolSession {
  registry: ToolRegistry;
  close: () => Promise<void>;
}

// Given the caller's forward headers, produce the tool registry for one chat turn: connect to the control plane's
// MCP as that principal, list its tools, keep the read-only subset (bridged as deferred), and add ToolSearch.
export type ToolProvider = (headers: ForwardHeaders) => Promise<ToolSession>;

const EMPTY_SESSION: ToolSession = { registry: new ToolRegistry([]), close: async () => {} };

export function mcpToolProvider(mcpUrl: string): ToolProvider {
  const url = new URL(mcpUrl);
  return async (headers) => {
    const client = new Client({ name: "everdict-agent", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: forwardHeaderRecord(headers) },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      const readTools = listed.tools.filter((t) => isReadOnlyToolName(t.name));
      if (readTools.length === 0) {
        await client.close().catch(() => {});
        return EMPTY_SESSION;
      }
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
        return { content: text, isError: r.isError === true };
      };
      const bridged: ToolDefinition[] = readTools.map((t) =>
        mcpToolToDefinition(
          {
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          },
          invoke,
        ),
      );
      const bridgedRegistry = new ToolRegistry(bridged);
      const registry = new ToolRegistry([buildToolSearchTool(bridgedRegistry), ...bridged]);
      return {
        registry,
        close: async () => {
          await client.close().catch(() => {});
        },
      };
    } catch {
      // Degrade rather than fail the chat: the agent answers from its own knowledge when the platform tools are
      // unreachable (e.g. MCP down / an unauthenticated dev session).
      await client.close().catch(() => {});
      return EMPTY_SESSION;
    }
  };
}
