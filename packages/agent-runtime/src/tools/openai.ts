import type OpenAI from "openai";
import { TOOL_SEARCH_TOOL_NAME, isDeferredTool } from "./deferred.js";
import type { ToolDefinition } from "./definition.js";
import type { ToolRegistry } from "./registry.js";

export function toOpenAiTool(tool: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema,
    },
  };
}

// Serialise the registry into the OpenAI tools[] shape with progressive disclosure: non-deferred tools and
// ToolSearch are always included; a deferred tool appears only once discovered (its name in discoveredNames).
export function toOpenAiTools(
  registry: ToolRegistry,
  discoveredNames: Set<string>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return registry
    .list()
    .filter((t) => {
      if (!isDeferredTool(t)) return true;
      if (t.name === TOOL_SEARCH_TOOL_NAME) return true;
      return discoveredNames.has(t.name);
    })
    .map(toOpenAiTool);
}
