import type { ToolDefinition } from "./definition.js";

export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

// The model-facing summary of a registered sub-agent type (its full config — instructions/model — lives in the loop).
export interface SubagentTypeInfo {
  name: string;
  description: string;
}

// Delegate a scoped sub-task to a fresh sub-agent with its OWN context (a nested run of the same loop). The sub-agent
// does the heavy tool work in isolation and returns only a summary, so the parent's context isn't polluted by the
// intermediate tool output — Claude Code's Task/sub-agent pattern. `runForeground` awaits the sub-agent and returns its
// summary; `runBackground` (when provided) launches it detached and returns an id immediately, so the parent keeps
// working (overlap) and the result is folded into a later turn. `types` (when non-empty) lets the model pick a
// specialized sub-agent type via `subagent_type`. Recursion is bounded by the loop's depth cap.
export function buildSpawnAgentTool(
  runForeground: (task: string, subagentType?: string) => Promise<string>,
  runBackground?: (task: string, subagentType?: string) => string,
  types?: SubagentTypeInfo[],
): ToolDefinition {
  const hasTypes = types !== undefined && types.length > 0;
  const baseDescription =
    "Delegate a scoped, self-contained sub-task to a fresh sub-agent that has its own context and the same read " +
    "tools. Use it for research or multi-step work whose intermediate tool output would clutter your own context — " +
    "the sub-agent does the work and returns only its final summary. Give it a COMPLETE, standalone instruction; it " +
    "cannot see this conversation.";
  const backgroundHint = runBackground
    ? " Set run_in_background to launch it detached and keep working — its findings arrive as a follow-up message " +
      "instead of blocking here; launch several that way to research in parallel."
    : "";
  const typesHint = hasTypes
    ? ` Optionally pick a specialized subagent_type:\n${types.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`
    : "";
  return {
    name: SPAWN_AGENT_TOOL_NAME,
    description: `${baseDescription}${backgroundHint}${typesHint}`,
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
        ...(hasTypes
          ? {
              subagent_type: {
                type: "string",
                enum: types.map((t) => t.name),
                description:
                  "Optional specialized sub-agent type to run this task as (see the list in the tool summary).",
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
      const rawType = (input as { subagent_type?: unknown }).subagent_type;
      const subagentType = typeof rawType === "string" && rawType.length > 0 ? rawType : undefined;
      if ((input as { run_in_background?: unknown }).run_in_background === true && runBackground) {
        const id = runBackground(task, subagentType);
        return {
          content: `Sub-agent ${id} launched in the background. Keep working — its findings will arrive as a follow-up message when it finishes.`,
          isError: false,
        };
      }
      const summary = await runForeground(task, subagentType);
      return { content: summary.length > 0 ? summary : "(the sub-agent returned no summary)", isError: false };
    },
  };
}
