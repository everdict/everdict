import type { ToolDefinition } from "./definition.js";

export const SEND_MESSAGE_TOOL_NAME = "send_message";

// Agent-to-agent messaging (S2 of docs/architecture/agent-teams.md, first increment): message a background sub-agent
// you launched — to give it new information, narrow its task, or ask it to wrap up — turning a fire-and-forget delegate
// into a two-way collaborator. `deliver` routes the message into that sub-agent's mailbox; it drains it at its next
// step. Delivery to an unknown / already-finished sub-agent is a soft error the model sees (not a throw).
//
// ── ONE TOOL, TWO REACHES — AND `isReadOnly` FOLLOWS THE REACH (pnpm scan, agent-runtime, 2026-09-11) ──
//
// Reaching only THIS run's own background sub-agents is cognition: they carry the same envelope, nothing
// leaves the task, and asking a human to approve each internal message would make the loop unusable. With
// the host's `sendMessage` seam wired the same tool ALSO delivers to a teammate or another session — an
// effect outside the task — and `kernel/loop.ts` already says so where it assembles the tool, dropping the
// `intrinsic()` exemption for exactly that case: "One tool, two reaches; the exemption follows the reach."
//
// The ENVELOPE exemption followed the reach. The PERMIT gate did not. `isReadOnly: true` was hardcoded and
// `effects` was absent, so `dispatchOne`'s
// `needsPermit = captured || isReadOnly !== true || (effects && effectsRequireConsent(effects))` evaluated
// FALSE and the host's consent hook was never consulted — the message reached a real recipient with no human
// in the loop. Its sibling `spawn_teammate` had this exact defect fixed (`isReadOnly: false`, and a
// regression test whose comment reads "Pre-fix, isReadOnly:true skipped the gate entirely"); this door never
// learned it, which is the sibling law rule `protocol` names.
export function buildSendMessageTool(
  deliver: (to: string, message: string) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>,
  // `true` when the host wired a seam that can deliver OUTSIDE this run. The caller knows; the tool cannot.
  opts: { external?: boolean } = {},
): ToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description:
      "Send a message to another agent — a background sub-agent you launched (by its id, e.g. 'bg-1', returned by " +
      "spawn_agent run_in_background) or, if your host exposes them, a named teammate/session. Use it to give a " +
      "running agent new information, refine its task, or ask it to wrap up — it receives your message at its next " +
      "step. Delivery to an unknown or already-finished recipient reports an error.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "The recipient id — a background sub-agent id like 'bg-1', or a teammate/session id/name.",
        },
        message: { type: "string", description: "The message to deliver to that agent." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    // Read-only ONLY while the reach is internal. A host seam makes this a write the permit hook decides.
    isReadOnly: opts.external !== true,
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
      const result = await deliver(to, message);
      return result.ok
        ? { content: `Delivered to ${to}.`, isError: false }
        : { content: result.error ?? `Could not deliver to ${to}.`, isError: true };
    },
  };
}
