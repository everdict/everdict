import type { ToolDefinition, ToolResult } from "../tools/definition.js";

// A tool spec as returned by an MCP server's tools/list (name + description + JSON-schema input).
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// The host owns the MCP transport/session; the kernel only needs a way to call a tool by name. This keeps the
// runtime free of any MCP SDK dependency (apps/agent injects a ResilientMcpSession-backed invoke).
export type McpInvoke = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

function asArgs(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

// Bridge one MCP tool spec into a runtime ToolDefinition. Marked isMcp → deferred by default (ToolSearch-gated).
// isReadOnly defaults to true (the built-in control-plane surface is read-only); a host bridging a write-allowed
// workspace server passes { isReadOnly: false } so the tool is honestly marked as mutating.
export function mcpToolToDefinition(
  spec: McpToolSpec,
  invoke: McpInvoke,
  opts?: { isReadOnly?: boolean },
): ToolDefinition {
  const params = spec.inputSchema ?? { type: "object", properties: {} };
  return {
    name: spec.name,
    description: spec.description ?? spec.name,
    parametersJsonSchema: params,
    isMcp: true,
    isReadOnly: opts?.isReadOnly ?? true,
    call: (input) => invoke(spec.name, asArgs(input)),
  };
}

export function bridgeMcpTools(specs: McpToolSpec[], invoke: McpInvoke): ToolDefinition[] {
  return specs.map((s) => mcpToolToDefinition(s, invoke));
}
