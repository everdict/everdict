import type { PermissionHook } from "@everdict/agent-runtime";
import type { TurnOutcome } from "./agent-activation.js";
import type { AgentMailbox } from "./agent-mailbox.js";
import { withTurnRun } from "./chat-run.js";
import { type ChatDeps, type ChatResult, type FailedTurnEvidence, contentToString, runChat } from "./chat.js";
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
  signal?: AbortSignal,
  permit?: PermissionHook,
  // Open a run for this turn on the ledger. Set by the callers that DON'T already own one — the supervisor
  // waking a teammate on a delivered message. The activation path leaves it off: it opened its run before
  // calling here (envelope, approval parking, event attribution), and a second one per turn would be a lie.
  ledger?: boolean,
  // Returns what the turn spent on the model AND the spans it recorded live, so the caller can put both in the
  // run's sealed evidence (O2 + N6). undefined = nothing ran (drained empty) or the turn died before its first
  // model call.
): Promise<TurnOutcome | undefined> {
  const headers = { authorization: `Bearer ${agentToken}` };
  try {
    // The agt_ token resolves to the agent principal (workspace + the creator it acts as). The SAME token is forwarded
    // to the MCP tools inside runChat, so every tool call is authenticated + RBAC-bounded exactly like the creator.
    const principal = await authenticate(headers);
    const drained = mailbox.drain(principal.workspace, sessionId);
    if (drained.length === 0) return undefined; // woken but nothing to react to (e.g. already drained by a prior turn)
    // The incoming messages (peer/event, attribution-rendered) are this turn's prompt; further messages that arrive
    // mid-turn are pulled by the loop's own drainInput at each turn boundary.
    const prompt = drained.map((m) => contentToString(m.content)).join("\n\n");
    // persistentRetry: an unattended turn has no user waiting on it — surviving a capacity dip (429/529 waited
    // out, Retry-After honored) beats failing fast and losing the reaction.
    const turn = (collectFailure?: (evidence: FailedTurnEvidence) => void): Promise<ChatResult> =>
      runChat({ ...deps, persistentRetry: true }, principal, headers, sessionId, prompt, undefined, undefined, signal, {
        drainInput: () => mailbox.drain(principal.workspace, sessionId),
        // Activation runs carry a mode-derived approval hook (agent-automation A6); a plain teammate turn has
        // none (its autonomy boundary is consent at spawn time).
        ...(permit ? { permit } : {}),
        ...(collectFailure ? { onFailedTurn: collectFailure } : {}),
      });
    const result =
      ledger === true
        ? await withTurnRun(
            deps,
            principal,
            sessionId,
            { cause: "event", eventKind: "teammate", label: "Teammate turn" },
            turn,
            signal,
          )
        : await turn();
    return {
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.spans && result.spans.length > 0 ? { spans: result.spans } : {}),
    };
  } catch (err) {
    console.error(`[agent] teammate turn failed for ${sessionId}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}
