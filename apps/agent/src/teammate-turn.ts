import type { AgentMailbox } from "./agent-mailbox.js";
import { type ChatDeps, contentToString, runChat } from "./chat.js";
import type { Authenticate } from "./principal.js";

// A3 (docs/architecture/agent-execution-auth.md + agent-teams.md S3): run ONE request-less turn for a teammate. Unlike
// a human /chat, there is no forwarded user bearer — the teammate authenticates with its own agt_ token (resolved by
// the control plane to a via:"agent" principal that acts AS its creator). The turn drains the teammate's mailbox and
// runs the agent loop over the incoming messages, so a peer's send_message or a platform event actually gets processed.
// Wired as the TeammateSupervisor's runTurn (which serializes turns + wakes on new messages). Best-effort: a failed
// turn is logged, never thrown — one bad turn must not wedge the supervisor's per-teammate loop.
export async function runTeammateTurn(
  deps: ChatDeps,
  authenticate: Authenticate,
  mailbox: AgentMailbox,
  sessionId: string,
  agentToken: string,
): Promise<void> {
  const headers = { authorization: `Bearer ${agentToken}` };
  try {
    // The agt_ token resolves to the agent principal (workspace + the creator it acts as). The SAME token is forwarded
    // to the MCP tools inside runChat, so every tool call is authenticated + RBAC-bounded exactly like the creator.
    const principal = await authenticate(headers);
    const drained = mailbox.drain(principal.workspace, sessionId);
    if (drained.length === 0) return; // woken but nothing to react to (e.g. already drained by a prior turn)
    // The incoming messages (peer/event, attribution-rendered) are this turn's prompt; further messages that arrive
    // mid-turn are pulled by the loop's own drainInput at each turn boundary.
    const prompt = drained.map((m) => contentToString(m.content)).join("\n\n");
    await runChat(deps, principal, headers, sessionId, prompt, undefined, undefined, undefined, {
      drainInput: () => mailbox.drain(principal.workspace, sessionId),
    });
  } catch (err) {
    console.error(`[agent] teammate turn failed for ${sessionId}:`, err instanceof Error ? err.message : err);
  }
}
