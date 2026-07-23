import type { ToolDefinition } from "./definition.js";

// A per-run store for large tool results. Instead of truncating a big payload (losing the tail forever), the loop
// stores the FULL result and feeds the model a preview + an id; the model pages through the rest with read_tool_result
// (Claude Code's persistence-first truncation, in-memory for the agent's ephemeral run).
export class ResultStore {
  private readonly byId = new Map<string, string>();
  put(id: string, content: string): void {
    this.byId.set(id, content);
  }
  get(id: string): string | undefined {
    return this.byId.get(id);
  }
}

// Results larger than this are offloaded (stored + previewed) rather than fed inline; ~16k chars ≈ ~4k tokens.
export const OFFLOAD_THRESHOLD_CHARS = 16_000;
const PREVIEW_CHARS = 2_000;
const DEFAULT_READ_LIMIT = 8_000;
export const READ_RESULT_TOOL_NAME = "read_tool_result";

// Store the full content and return the preview + reference the model sees in place of the oversized result.
export function offloadResult(store: ResultStore, id: string, content: string): string {
  store.put(id, content);
  return [
    `[Large tool result stored as "${id}" — ${content.length} chars total. Preview (first ${PREVIEW_CHARS}):`,
    content.slice(0, PREVIEW_CHARS),
    `… Call ${READ_RESULT_TOOL_NAME} with id "${id}" (and offset/limit) to read more.]`,
  ].join("\n");
}

// The native (always-loaded) tool that pages through a stored large result.
export function buildReadResultTool(store: ResultStore): ToolDefinition {
  return {
    name: READ_RESULT_TOOL_NAME,
    description:
      "Read a window of a large tool result that was stored (its id appears in a truncated '[Large tool result stored as …]' message). Use offset/limit to page through the full content.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The stored result id." },
        offset: { type: "number", description: "Start character offset (default 0)." },
        limit: { type: "number", description: "Max characters to return (default 8000)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const o = input as { id?: unknown; offset?: unknown; limit?: unknown };
      const id = typeof o.id === "string" ? o.id : "";
      const full = store.get(id);
      if (full === undefined) return { content: `No stored result with id "${id}".`, isError: true };
      const offset = typeof o.offset === "number" && o.offset >= 0 ? Math.floor(o.offset) : 0;
      const limit = typeof o.limit === "number" && o.limit > 0 ? Math.floor(o.limit) : DEFAULT_READ_LIMIT;
      const window = full.slice(offset, offset + limit);
      const remaining = full.length - offset - window.length;
      const more = remaining > 0 ? `\n… (${remaining} more chars — increase offset to continue)` : "";
      return { content: `${window}${more}`, isError: false };
    },
  };
}
