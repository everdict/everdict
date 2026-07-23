import type { ZodTypeAny } from "zod";

export interface ToolContext {
  abortSignal?: AbortSignal;
  selectedModel?: string;
}

// An image a tool returned (a base64 payload + its MIME type) — e.g. a browser screenshot or a rendered DOM. The loop
// feeds these to the model as image content so it can actually SEE them (multimodal tool results).
export interface ToolResultImage {
  data: string; // base64 (no data: prefix)
  mediaType: string; // e.g. "image/png"
}

// A tool result: string content fed back as a `tool` message (+ an error flag so the loop records success/failure
// without inspecting the text), plus any images the loop surfaces to the model in a follow-up multimodal user turn.
export interface ToolResult {
  content: string;
  isError: boolean;
  images?: ToolResultImage[];
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
