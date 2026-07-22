import type { ZodTypeAny } from "zod";

export interface ToolContext {
  abortSignal?: AbortSignal;
  selectedModel?: string;
}

// A tool result is always string content fed back to the model as a `tool` message (plus an error flag so the
// loop can record success/failure without inspecting the text).
export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema object handed verbatim to the OpenAI `tools[]` function.parameters.
  parametersJsonSchema: Record<string, unknown>;
  // Optional runtime validation of the parsed arguments before `call` (native tools use it; MCP-bridged tools
  // rely on the server's own validation).
  inputSchema?: ZodTypeAny;
  isReadOnly?: boolean;
  isDestructive?: boolean;
  // ToolSearch progressive disclosure (Claude Code parity): a deferred tool is held out of the outbound tools[]
  // until the model discovers it via ToolSearch, keeping the per-call surface bounded across many MCP tools.
  isMcp?: boolean;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  // One-line capability phrase used by ToolSearch keyword scoring; falls back to `description`.
  searchHint?: string;
  call: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
