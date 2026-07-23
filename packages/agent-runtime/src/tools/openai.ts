import type { LlmTool } from "@everdict/llm";
import type OpenAI from "openai";
import { TOOL_SEARCH_TOOL_NAME, isDeferredTool } from "./deferred.js";
import type { ToolDefinition } from "./definition.js";
import type { ToolRegistry } from "./registry.js";

// Progressive-disclosure filter shared by both serialisers: non-deferred tools + ToolSearch are always visible; a
// deferred tool appears only once discovered.
function visibleTools(registry: ToolRegistry, discoveredNames: Set<string>): ToolDefinition[] {
  return registry.list().filter((t) => {
    if (!isDeferredTool(t)) return true;
    if (t.name === TOOL_SEARCH_TOOL_NAME) return true;
    return discoveredNames.has(t.name);
  });
}

// Serialise the registry into the provider-neutral LlmTool[] the transport consumes (it renders the JSON-Schema
// parameters into each provider's own tool format). This is the shape the kernel passes to LlmTransport.stream.
export function toLlmTools(registry: ToolRegistry, discoveredNames: Set<string>): LlmTool[] {
  return visibleTools(registry, discoveredNames).map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parametersJsonSchema,
  }));
}

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

// Serialise the registry into the OpenAI tools[] shape with the same progressive disclosure. Kept for callers that
// speak the OpenAI tool shape directly; the kernel itself now passes provider-neutral LlmTool[] via toLlmTools.
export function toOpenAiTools(
  registry: ToolRegistry,
  discoveredNames: Set<string>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return visibleTools(registry, discoveredNames).map(toOpenAiTool);
}
