import type { ToolDefinition } from "./definition.js";

export const SPAWN_TEAMMATE_TOOL_NAME = "spawn_teammate";

// Spawn a persistent TEAMMATE (agent-teams.md S3) — a long-lived autonomous agent with its own context and a standing
// task, addressable by id so you (and others) can send_message it. Unlike spawn_agent (a one-shot scoped sub-task that
// returns a summary), a teammate keeps running and reacts to messages/events on its own. The host callback creates the
// teammate (its session + execution token) and returns its id; this tool is only present when the host wires it.
export function buildSpawnTeammateTool(
  spawn: (name: string, task: string) => Promise<{ id: string } | { error: string }>,
): ToolDefinition {
  return {
    name: SPAWN_TEAMMATE_TOOL_NAME,
    description:
      "Spawn a persistent teammate: a long-lived autonomous agent with its own context that works on a standing " +
      "task and that you (or other agents) can reach with send_message by its id. Use it — instead of spawn_agent — " +
      "when the work is ongoing/collaborative rather than a one-shot scoped sub-task. Give it a short name and a " +
      "clear standing task; it starts working immediately and keeps reacting to messages until stopped.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for the teammate (e.g. 'researcher')." },
        task: { type: "string", description: "The teammate's standing task — what it should keep working on." },
      },
      required: ["name", "task"],
      additionalProperties: false,
    },
    isReadOnly: true, // spawning is orchestration; the teammate's OWN actions are bounded by its execution token
    alwaysLoad: true,
    call: async (input) => {
      const name = (input as { name?: unknown }).name;
      const task = (input as { task?: unknown }).task;
      if (typeof name !== "string" || name.trim().length === 0) {
        return { content: "spawn_teammate: 'name' must be a non-empty short name.", isError: true };
      }
      if (typeof task !== "string" || task.trim().length === 0) {
        return { content: "spawn_teammate: 'task' must be a non-empty standing task.", isError: true };
      }
      const result = await spawn(name, task);
      if ("error" in result) {
        return { content: `Could not spawn teammate "${name}": ${result.error}`, isError: true };
      }
      return {
        content: `Spawned teammate "${name}" (id ${result.id}). It is working on its task now; reach it with send_message(to: "${result.id}", …).`,
        isError: false,
      };
    },
  };
}
