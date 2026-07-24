import type { ToolDefinition } from "./definition.js";

export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

// Delegate a scoped sub-task to a fresh sub-agent with its OWN context (a nested run of the same loop). The sub-agent
// does the heavy tool work in isolation and returns only a summary, so the parent's context isn't polluted by the
// intermediate tool output — Claude Code's Task/sub-agent pattern. `runForeground` awaits the sub-agent and returns its
// summary; `runBackground` (when provided) launches it detached and returns an id immediately, so the parent keeps
// working (overlap) and the result is folded into a later turn. Recursion is bounded by the loop's depth cap.
export function buildSpawnAgentTool(
  runForeground: (task: string) => Promise<string>,
  runBackground?: (task: string) => string,
): ToolDefinition {
  const baseDescription =
    "Delegate a scoped, self-contained sub-task to a fresh sub-agent that has its own context and the same read " +
    "tools. Use it for research or multi-step work whose intermediate tool output would clutter your own context — " +
    "the sub-agent does the work and returns only its final summary. Give it a COMPLETE, standalone instruction; it " +
    "cannot see this conversation.";
  const backgroundHint = runBackground
    ? " Set run_in_background to launch it detached and keep working — its findings arrive as a follow-up message " +
      "instead of blocking here; launch several that way to research in parallel."
    : "";
  return {
    name: SPAWN_AGENT_TOOL_NAME,
    description: `${baseDescription}${backgroundHint}`,
    parametersJsonSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "A complete, standalone instruction for the sub-agent." },
        ...(runBackground
          ? {
              run_in_background: {
                type: "boolean",
                description:
                  "Run the sub-agent detached instead of waiting for it. You keep working and its result is delivered " +
                  "as a follow-up message when it finishes. Use it to overlap independent research with your own work.",
              },
            }
          : {}),
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
      if ((input as { run_in_background?: unknown }).run_in_background === true && runBackground) {
        const id = runBackground(task);
        return {
          content: `Sub-agent ${id} launched in the background. Keep working — its findings will arrive as a follow-up message when it finishes.`,
          isError: false,
        };
      }
      const summary = await runForeground(task);
      return { content: summary.length > 0 ? summary : "(the sub-agent returned no summary)", isError: false };
    },
  };
}
