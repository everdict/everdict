import type { ToolDefinition } from "./definition.js";

// A workspace skill made available to the agent: a name + a discovery line (description) + the full procedure (body).
// The name + description are cheap and always visible (listed in the tool description); the body is loaded on demand
// when the model calls the tool — Claude-Code-style progressive disclosure.
export interface SkillEntry {
  name: string;
  description: string;
  instructions: string;
}

export const USE_SKILL_TOOL_NAME = "use_skill";

// Build the `use_skill` tool from the workspace's skills. A single native (always-loaded) tool whose description lists
// every available skill (name — description) so the model can decide when a procedure applies, and whose call returns
// the chosen skill's full instructions for the model to follow. Read-only: a skill is guidance, not an action (actions
// come from MCP tools). Returns undefined when the workspace has no skills (the tool is simply not added).
export function buildSkillTool(skills: SkillEntry[]): ToolDefinition | undefined {
  if (skills.length === 0) return undefined;
  const byName = new Map(skills.map((s) => [s.name, s.instructions]));
  const listing = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const description = [
    "Load a workspace SKILL — a saved, workspace-authored procedure to follow for a recurring task. Call this with a",
    "skill's name to get its full step-by-step instructions, then follow them. Use a skill whenever the task matches",
    "one below; otherwise proceed normally.",
    "",
    "Available skills:",
    listing,
  ].join("\n");

  return {
    name: USE_SKILL_TOOL_NAME,
    description,
    parametersJsonSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          enum: skills.map((s) => s.name),
          description: "The name of the skill to load (one of the available skills).",
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true, // a native tool — always present in tools[], never deferred behind ToolSearch
    call: async (input) => {
      const name =
        input !== null && typeof input === "object" && "skill" in input && typeof input.skill === "string"
          ? input.skill
          : undefined;
      const body = name !== undefined ? byName.get(name) : undefined;
      if (name === undefined || body === undefined) {
        return {
          content: `No such skill${name !== undefined ? ` "${name}"` : ""}. Available: ${skills.map((s) => s.name).join(", ")}.`,
          isError: true,
        };
      }
      return { content: `# Skill: ${name}\n\n${body}`, isError: false };
    },
  };
}
