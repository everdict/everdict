import type { AgentSessionStore } from "@everdict/application-control";
import { type TraceEvent, stamp } from "@everdict/contracts";
import type { ChatResult, FailedTurnEvidence } from "./chat.js";
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

// What opened a turn, in the ledger's own terms. `cause` picks the record the control plane mints — "chat" is
// the member-caused interactive one (ledger-only, deliberately off the event log), "event" the headless one an
// activation already uses, which belongs on the log because nobody watched it happen. `label` names the turn in
// the run's message; `eventKind` is its subtype.
export interface TurnKind {
  cause: "event" | "chat";
  eventKind: string;
  label: string;
}

const CHAT_TURN: TurnKind = { cause: "chat", eventKind: "chat", label: "Chat turn" };

// A turn is a run (execution-model.md decision O1). This wraps a turn entry point in the ledger grammar the
// activation path already uses: mint one run id per turn, open it before the loop starts, settle it with the
// turn's own record (spans) or its transcript projected as a trace (O2). It is what makes a turn VISIBLE — a
// turn that runs outside this wrapper leaves the workspace's evidence ledger with nothing at all, however much
// work it did. The activation path is deliberately NOT wrapped: it owns its run already (envelope, approval
// parking, event attribution), and wrapping it would open a second run per turn.
//
// The run id is written onto the SESSION before the turn starts, which is load-bearing twice over: the tool
// headers runChat builds read it (so work the agent submits mid-turn is stamped `causedBy` this run), and a
// later approval/stop path can find the run behind the conversation.
//
// Best-effort by contract, like every report on this bridge: an unreachable control plane costs the ledger
// entry, never the member's answer.
export async function withTurnRun(
  deps: ChatRunDeps,
  principal: Principal,
  sessionId: string,
  kind: TurnKind,
  // The turn is handed the sink its OWN failure evidence goes into (`ChatHooks.onFailedTurn`): a thrown turn
  // has no return value to carry its record, and that is precisely the turn whose record matters.
  turn: (collectFailure: (evidence: FailedTurnEvidence) => void) => Promise<ChatResult>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  let failed: FailedTurnEvidence | undefined;
  const collectFailure = (evidence: FailedTurnEvidence): void => {
    failed = evidence;
  };
  const report = deps.reportRunEvent;
  if (!report) return turn(collectFailure);
  const { workspace, subject } = principal;
  // A missing/invisible session is not this wrapper's error to raise — the turn itself answers with NotFound.
  const session = await deps.sessions.getVisibleSession(workspace, subject, sessionId).catch(() => undefined);
  if (!session) return turn(collectFailure);

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
    eventKind: kind.eventKind,
    message: `${kind.label} in conversation ${sessionId}.`,
    runId,
    creator: subject,
    cause: kind.cause,
  }).catch(() => {});

  const settle = (
    outcome: "agent.run.completed" | "agent.run.failed" | "agent.run.cancelled",
    message: string,
    messages?: ChatResult["messages"],
    usage?: ChatResult["usage"],
    spans?: ChatResult["spans"],
    // Why a turn ended without a result. Kept as the LAST resort for evidence: a turn that died before it
    // recorded anything still says that much, so the ledger never holds a run with nothing under it.
    failure?: string,
  ): void => {
    // Prefer the RECORD the turn kept for itself; the transcript projection is the fallback for a turn that
    // ran without one (no run id to hang spans under), and the bare failure is the fallback for a turn that
    // died with neither.
    // The test is "did it record anything", not "is the field set" — an EMPTY span list is a turn with no
    // record, and reading it as one suppressed the transcript fallback below (which only attaches non-empty
    // spans), settling the run with no evidence at all.
    const recorded = spans !== undefined && spans.length > 0;
    const trace: TraceEvent[] = recorded
      ? []
      : messages
        ? transcriptToTrace(messages, usage)
        : failure !== undefined
          ? [{ ...stamp(Date.now), kind: "error", message: failure }]
          : [];
    void report({
      workspace,
      kind: outcome,
      sessionId,
      agentId,
      ...(agentVersion !== undefined ? { agentVersion } : {}),
      eventKind: kind.eventKind,
      message,
      runId,
      creator: subject,
      cause: kind.cause,
      ...(trace.length > 0 ? { trace } : {}),
      ...(spans && spans.length > 0 ? { spans } : {}),
    }).catch(() => {});
  };

  try {
    const result = await turn(collectFailure);
    settle(
      "agent.run.completed",
      `${kind.label} completed in conversation ${sessionId}.`,
      result.messages,
      result.usage,
      result.spans,
    );
    return result;
  } catch (err) {
    // A stopped turn is cancelled, not failed — the ledger must not call a member's own stop a failure. Either
    // way it settles WITH the turn's evidence: the spans it recorded before it died (collected through
    // `onFailedTurn`, since a thrown turn returns nothing), or failing that the reason itself. A run whose
    // trajectory is empty is a run that cannot be examined, and the dead ones are the ones examined most.
    const stopped = signal?.aborted === true;
    const reason = failed?.reason ?? (err instanceof Error ? err.message : String(err));
    settle(
      stopped ? "agent.run.cancelled" : "agent.run.failed",
      stopped
        ? `${kind.label} cancelled in conversation ${sessionId}.`
        : `${kind.label} failed in conversation ${sessionId}${err instanceof Error ? `: ${err.message}` : ""}.`,
      undefined,
      failed?.usage,
      failed?.spans,
      reason,
    );
    throw err;
  }
}

// The member-typed turn — the chat route's own entry point, and the shape every other turn kind is measured
// against.
export function withChatTurnRun(
  deps: ChatRunDeps,
  principal: Principal,
  sessionId: string,
  turn: (collectFailure: (evidence: FailedTurnEvidence) => void) => Promise<ChatResult>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  return withTurnRun(deps, principal, sessionId, CHAT_TURN, turn, signal);
}
