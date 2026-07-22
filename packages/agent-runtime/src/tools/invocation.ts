import type { ToolContext, ToolDefinition, ToolResult } from "./definition.js";

// Invoke a tool defensively: a validation failure or a thrown error becomes an `isError` ToolResult rather than
// propagating, so the loop can still push a matching `tool` message (assistant.tool_calls ↔ tool result pairing
// must hold or the next LLM call rejects).
export async function invokeTool(tool: ToolDefinition, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const parsed = tool.inputSchema ? tool.inputSchema.parse(input) : input;
    return await tool.call(parsed, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Tool ${tool.name} failed: ${message}`, isError: true };
  }
}
