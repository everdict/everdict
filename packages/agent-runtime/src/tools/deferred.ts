import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "./definition.js";

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

// A tool is deferred (held out of the outbound tools[]) until discovered via ToolSearch. Rules (Claude Code
// parity): alwaysLoad wins → ToolSearch itself is never deferred → MCP tools default deferred → shouldDefer.
export function isDeferredTool(t: ToolDefinition): boolean {
  if (t.alwaysLoad === true) return false;
  if (t.name === TOOL_SEARCH_TOOL_NAME) return false;
  if (t.isMcp === true) return true;
  return t.shouldDefer === true;
}

// Discovery is memorised structurally in the transcript: ToolSearch's tool result is
// `{ tool_name: "ToolSearch", output: { matches: [...] } }`. Scan tool messages and lift matches[].
export function extractDiscoveredToolNames(messages: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    if (typeof m.content !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as { tool_name?: unknown; output?: unknown };
    if (p.tool_name !== TOOL_SEARCH_TOOL_NAME) continue;
    if (!p.output || typeof p.output !== "object") continue;
    const matches = (p.output as { matches?: unknown }).matches;
    if (!Array.isArray(matches)) continue;
    for (const n of matches) {
      if (typeof n === "string") out.add(n);
    }
  }
  return out;
}

// Name-only listing of not-yet-discovered deferred tools, appended to the system prompt (~10 tokens/tool vs
// ~200-400 for a full schema).
export function renderDeferredToolList(tools: ReadonlyArray<ToolDefinition>, discoveredNames: Set<string>): string {
  const sorted = tools
    .filter((t) => isDeferredTool(t) && !discoveredNames.has(t.name))
    .map((t) => t.name)
    .sort();
  if (sorted.length === 0) return "";
  return ["<available-deferred-tools>", ...sorted, "</available-deferred-tools>"].join("\n");
}
