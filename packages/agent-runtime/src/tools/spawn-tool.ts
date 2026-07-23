import type { ToolDefinition } from "./definition.js";

export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

// Delegate a scoped sub-task to a fresh sub-agent with its OWN context (a nested run of the same loop). The sub-agent
// does the heavy tool work in isolation and returns only a summary, so the parent's context isn't polluted by the
// intermediate tool output — Claude Code's Task/sub-agent pattern. `runNested` (the loop's closure over runAgentLoop at
// depth+1) executes it; recursion is bounded by the loop's depth cap.
export function buildSpawnAgentTool(runNested: (task: string) => Promise<string>): ToolDefinition {
  return {
    name: SPAWN_AGENT_TOOL_NAME,
    description:
      "Delegate a scoped, self-contained sub-task to a fresh sub-agent that has its own context and the same read " +
      "tools. Use it for research or multi-step work whose intermediate tool output would clutter your own context — " +
      "the sub-agent does the work and returns only its final summary. Give it a COMPLETE, standalone instruction; it " +
      "cannot see this conversation.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "A complete, standalone instruction for the sub-agent." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const task = (input as { task?: unknown }).task;
      if (typeof task !== "string" || task.trim().length === 0) {
        return { content: "spawn_agent: 'task' must be a non-empty instruction.", isError: true };
      }
      const summary = await runNested(task);
      return { content: summary.length > 0 ? summary : "(the sub-agent returned no summary)", isError: false };
    },
  };
}
