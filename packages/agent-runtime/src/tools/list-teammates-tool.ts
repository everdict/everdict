import type { ToolDefinition } from "./definition.js";

export const LIST_TEAMMATES_TOOL_NAME = "list_teammates";

// A teammate the agent can see + coordinate with (its id is how send_message reaches it).
export interface TeammateInfo {
  id: string;
  name: string;
  watch?: string[]; // event kinds it reacts to proactively (if any)
}

// Discovery for autonomous collaboration (agent-teams.md S3): let an agent see its live teammates so it can coordinate
// them with send_message — spawned by it or by a peer in the same workspace. Read-only. Present only when the host
// wires the roster.
export function buildListTeammatesTool(list: () => Promise<TeammateInfo[]>): ToolDefinition {
  return {
    name: LIST_TEAMMATES_TOOL_NAME,
    description:
      "List your live teammates — persistent autonomous agents (spawned by you or a peer) you can coordinate with " +
      "via send_message using the id shown. Use it to see who is on the team before delegating or messaging.",
    parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: true,
    alwaysLoad: true,
    call: async () => {
      const teammates = await list();
      if (teammates.length === 0) {
        return { content: "No teammates yet. Use spawn_teammate to create one.", isError: false };
      }
      const lines = teammates.map((t) => {
        const watching = t.watch && t.watch.length > 0 ? ` — watches ${t.watch.join(", ")}` : "";
        return `- ${t.id}: ${t.name}${watching}`;
      });
      return {
        content: `Your teammates (message one with send_message(to: <id>, …)):\n${lines.join("\n")}`,
        isError: false,
      };
    },
  };
}
