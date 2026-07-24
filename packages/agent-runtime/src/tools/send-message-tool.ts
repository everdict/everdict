import type { ToolDefinition } from "./definition.js";

export const SEND_MESSAGE_TOOL_NAME = "send_message";

// Agent-to-agent messaging (S2 of docs/architecture/agent-teams.md, first increment): message a background sub-agent
// you launched — to give it new information, narrow its task, or ask it to wrap up — turning a fire-and-forget delegate
// into a two-way collaborator. `deliver` routes the message into that sub-agent's mailbox; it drains it at its next
// step. Delivery to an unknown / already-finished sub-agent is a soft error the model sees (not a throw).
export function buildSendMessageTool(
  deliver: (to: string, message: string) => { ok: boolean; error?: string },
): ToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description:
      "Send a message to a background sub-agent you launched, by its id (e.g. 'bg-1', returned when you launched it " +
      "with spawn_agent run_in_background). Use it to give the running sub-agent new information, refine its task, or " +
      "ask it to wrap up — it receives your message at its next step. Only works while that sub-agent is still running.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "The background sub-agent id to message (e.g. 'bg-1'), as returned when you launched it.",
        },
        message: { type: "string", description: "The message to deliver to that sub-agent." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const to = (input as { to?: unknown }).to;
      const message = (input as { message?: unknown }).message;
      if (typeof to !== "string" || to.trim().length === 0) {
        return { content: "send_message: 'to' must be a sub-agent id (e.g. 'bg-1').", isError: true };
      }
      if (typeof message !== "string" || message.trim().length === 0) {
        return { content: "send_message: 'message' must be a non-empty string.", isError: true };
      }
      const result = deliver(to, message);
      return result.ok
        ? { content: `Delivered to ${to}.`, isError: false }
        : { content: result.error ?? `Could not deliver to ${to}.`, isError: true };
    },
  };
}
