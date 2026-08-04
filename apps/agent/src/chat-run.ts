import type { AgentSessionStore } from "@everdict/application-control";
import type { ChatResult } from "./chat.js";
import type { Principal } from "./principal.js";
import { transcriptToTrace } from "./run-trace.js";
import type { AgentRunEventReport } from "./usage.js";

// The agent id a plain conversation runs as — the workspace's own chat configuration, which is what
// `resolveProfile` falls back to when a session names no crafted agent.
const DEFAULT_CHAT_AGENT = "default";

export interface ChatRunDeps {
  sessions: Pick<AgentSessionStore, "getVisibleSession" | "setSessionRunId">;
  now: () => string;
  newId: () => string;
  // The same lifecycle bridge the activation path uses. Absent → no ledger (dev wiring / tests): the turn
  // still runs, it just isn't recorded.
  reportRunEvent?: (input: AgentRunEventReport) => Promise<void>;
}

// A chat turn is a run (execution-model.md decision O1). This wraps the INTERACTIVE turn entry points — the
// chat route and the comment-thread discussion turn — in the same ledger grammar the activation path already
// uses: mint one run id per turn, open it before the loop starts, settle it with the turn's transcript
// projected as a trace (O2). The activation path is deliberately NOT wrapped: it owns its run already
// (envelope, approval parking, event attribution), and wrapping it would open a second run per turn.
//
// The run id is written onto the SESSION before the turn starts, which is load-bearing twice over: the tool
// headers runChat builds read it (so work the agent submits mid-turn is stamped `causedBy` this run), and a
// later approval/stop path can find the run behind the conversation.
//
// Best-effort by contract, like every report on this bridge: an unreachable control plane costs the ledger
// entry, never the member's answer.
export async function withChatTurnRun(
  deps: ChatRunDeps,
  principal: Principal,
  sessionId: string,
  turn: () => Promise<ChatResult>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const report = deps.reportRunEvent;
  if (!report) return turn();
  const { workspace, subject } = principal;
  // A missing/invisible session is not this wrapper's error to raise — the turn itself answers with NotFound.
  const session = await deps.sessions.getVisibleSession(workspace, subject, sessionId).catch(() => undefined);
  if (!session) return turn();

  const runId = deps.newId();
  const agentId = session.origin?.agentId ?? DEFAULT_CHAT_AGENT;
  const agentVersion = session.origin?.agentVersion;
  await deps.sessions.setSessionRunId(workspace, sessionId, runId, deps.now()).catch(() => {});
  void report({
    workspace,
    kind: "agent.run.started",
    sessionId,
    agentId,
    ...(agentVersion !== undefined ? { agentVersion } : {}),
    eventKind: "chat",
    message: `Chat turn in conversation ${sessionId}.`,
    runId,
    creator: subject,
    cause: "chat",
  }).catch(() => {});

  const settle = (
    kind: "agent.run.completed" | "agent.run.failed" | "agent.run.cancelled",
    message: string,
    messages?: ChatResult["messages"],
    usage?: ChatResult["usage"],
    spans?: ChatResult["spans"],
  ): void => {
    // Prefer the RECORD the turn kept for itself; the transcript projection is the fallback for a turn that
    // ran without one (no run id to hang spans under).
    const trace = spans === undefined && messages ? transcriptToTrace(messages, usage) : [];
    void report({
      workspace,
      kind,
      sessionId,
      agentId,
      ...(agentVersion !== undefined ? { agentVersion } : {}),
      eventKind: "chat",
      message,
      runId,
      creator: subject,
      cause: "chat",
      ...(trace.length > 0 ? { trace } : {}),
      ...(spans && spans.length > 0 ? { spans } : {}),
    }).catch(() => {});
  };

  try {
    const result = await turn();
    settle(
      "agent.run.completed",
      `Chat turn completed in conversation ${sessionId}.`,
      result.messages,
      result.usage,
      result.spans,
    );
    return result;
  } catch (err) {
    // A stopped turn is cancelled, not failed — the transcript is evidence either way, but the ledger must not
    // call a member's own stop a failure. The turn's records are already persisted; the trace of a dead turn is
    // read back from the transcript rather than the (absent) result.
    const stopped = signal?.aborted === true;
    settle(
      stopped ? "agent.run.cancelled" : "agent.run.failed",
      stopped
        ? `Chat turn cancelled in conversation ${sessionId}.`
        : `Chat turn failed in conversation ${sessionId}${err instanceof Error ? `: ${err.message}` : ""}.`,
    );
    throw err;
  }
}
