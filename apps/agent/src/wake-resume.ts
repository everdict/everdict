import type { AgentSessionRecord, AgentWakeIntent } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import { eventSelectorMatches } from "@everdict/domain";
import { withTurnRun } from "./chat-run.js";
import { type ChatDeps, runChat } from "./chat.js";
import type { Authenticate } from "./principal.js";

// Resuming a parked conversation (LESSON 051). The counterpart of the `wait_for` tool: when an agent ends a turn
// with stopReason "waiting", its wake intent stays on the session; here it is honored.
//
// This is deliberately NOT the activation path. AgentActivator answers "a fact happened — which crafted agents
// should REACT?" by starting a fresh trigger-origin run. This answers "which conversation is already waiting for
// exactly this?" and continues THAT one, with its whole history, where the member is looking. Activation is a new
// worker for new work; resumption is the same worker finishing what it started.

export interface WakeEvent {
  workspace: string;
  kind: string;
  message: string;
  source?: string;
  payload?: Record<string, unknown>;
}

export interface WakeResumeDeps {
  chat: ChatDeps;
  authenticate: Authenticate;
  // Mints the one-shot agt_ token the resumed turn runs under (as the conversation's owner) — same credential
  // discipline as an activation: minted for this turn, revoked with it. Absent → resumption is disabled.
  keyStore?: Parameters<typeof issueAgentToken>[0];
  // A conversation with a turn already in flight is skipped and left armed: whatever is running will re-park (or
  // clear) the intent when it finishes, and the deadline sweep is the backstop. Never double-run a session.
  isLive?: (workspace: string, sessionId: string) => boolean;
  // The request-less turn itself — injected so tests own it (the same seam AgentActivator's runTurn uses).
  // Absent → the real one: authenticate the minted token, then run a chat turn over the resume prompt.
  runTurn?: (session: AgentSessionRecord, prompt: string, agentToken: string) => Promise<void>;
}

export function wakeIntentMatches(intent: AgentWakeIntent, event: WakeEvent): boolean {
  // One selector grammar, one matcher — the same predicate agent triggers and E3 subscriptions are judged by.
  return eventSelectorMatches(
    { kinds: intent.kinds, filters: intent.filters },
    { kind: event.kind, ...(event.payload ? { payload: event.payload } : {}) },
  );
}

// The resumed turn's opening message (Claude Code's `<task-notification>` reinterpreted). It is stored as a `user`
// record, the same convention mailbox deliveries follow, so the transcript reads as "something told the agent" —
// and the agent's own note comes back to it, because the reason for waiting is context the next turn needs.
export function resumePrompt(intent: AgentWakeIntent, event: WakeEvent | undefined, now: string): string {
  const head = event
    ? `<event-notification kind="${event.kind}">\n${event.message}\n</event-notification>`
    : `<wake-notification reason="deadline">\nNothing arrived before your deadline (${intent.deadlineAt}). It is now ${now}.\n</wake-notification>`;
  const body = event
    ? "This is what you asked to be woken for. Check what actually happened (do not assume the event tells the whole story), then report the outcome to the member in this conversation."
    : "The work you were watching never reported in. Check its current state: if it is still running, you may wait again with a new deadline; if it died or is stuck, say so plainly and tell the member what you recommend.";
  return `${head}\n\nYou were waiting for this: "${intent.note}"\n\n${body} If more waiting is warranted, call wait_for again — do not end your turn by asking the member to check back.`;
}

export interface WakeResumer {
  // Resume every conversation in the workspace whose wake intent selects this event. Returns how many were resumed.
  onEvent(event: WakeEvent): Promise<number>;
  // Resume every conversation anywhere whose deadline has passed — the restart-proof backstop (W3). A job that dies
  // without emitting a terminal fact must not strand its watcher, and a wait armed before a restart must not be lost.
  sweep(now: string, limit?: number): Promise<number>;
}

// The real turn: the agt_ token resolves to a principal acting AS the conversation's owner, and the SAME token is
// forwarded to the MCP tools inside runChat — so a resumed turn reads and writes exactly what the member could.
function defaultRunTurn(deps: WakeResumeDeps): NonNullable<WakeResumeDeps["runTurn"]> {
  return async (session, prompt, agentToken) => {
    const headers = { authorization: `Bearer ${agentToken}` };
    const principal = await deps.authenticate(headers);
    // A woken turn is headless work — nobody was watching it start, which is exactly why it has to leave a
    // record. Without the wrapper the resume ran outside the ledger entirely: the member came back to an answer
    // whose work had no trace behind it.
    await withTurnRun(
      deps.chat,
      principal,
      session.id,
      { cause: "event", eventKind: "wake", label: "Wake-up turn" },
      (collectFailure) =>
        // persistentRetry: nobody is necessarily watching this turn, so surviving a capacity dip beats failing fast —
        // the whole point of the wait was that the member should not have to come back and ask.
        runChat(
          { ...deps.chat, persistentRetry: true },
          principal,
          headers,
          session.id,
          prompt,
          undefined,
          undefined,
          undefined,
          {
            onFailedTurn: collectFailure,
          },
        ),
    );
  };
}

export function buildWakeResumer(deps: WakeResumeDeps): WakeResumer {
  // Per-session serialization: an event and the sweep can land at once, and a resumed turn is not cheap.
  const inFlight = new Set<string>();

  const resume = async (session: AgentSessionRecord, event: WakeEvent | undefined): Promise<boolean> => {
    const intent = session.wakeIntent;
    const keyStore = deps.keyStore;
    if (!intent || !keyStore) return false;
    const key = `${session.tenant}/${session.id}`;
    if (inFlight.has(key)) return false;
    if (deps.isLive?.(session.tenant, session.id) === true) return false;
    inFlight.add(key);
    try {
      // Claim FIRST, atomically. The intent is a one-shot claim, not a subscription: whoever clears it owns the
      // resume, so a second event landing at the same instant (or another replica's sweep) cannot double-run the
      // conversation. The turn itself decides whether to wait again — calling wait_for re-arms it. A crash between
      // the claim and the turn costs one wake-up, never a duplicate run.
      if (!(await deps.chat.sessions.claimWakeIntent(session.tenant, session.id, deps.chat.now()))) return false;
      const { token, id: keyId } = await issueAgentToken(keyStore, session.tenant, session.owner, ["write"], "wake");
      try {
        const runTurn = deps.runTurn ?? defaultRunTurn(deps);
        await runTurn(session, resumePrompt(intent, event, deps.chat.now()), token);
      } finally {
        // One-shot execution credential, revoked with the turn — no standing token accumulation.
        await keyStore.revoke(session.tenant, keyId, session.owner).catch(() => {});
      }
      return true;
    } catch (err) {
      // A failed resume is logged, never thrown: one wedged conversation must not stop the others on this event,
      // and the turn's own failure path has already made the failure a citizen of the transcript.
      console.error(
        `[agent] wake resume failed (${session.tenant}/${session.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    async onEvent(event) {
      if (!deps.keyStore) return 0;
      const waiting = await deps.chat.sessions.listWaitingSessions(event.workspace);
      // NOTE: no causedBy loop guard here, on purpose. An agent must not wake on its own INCIDENTAL effects — but a
      // wait is an explicit, one-shot request to be woken by exactly this, and the work it is watching is usually
      // work it started itself (agent runs scorecard → scorecard.completed carries its causation). Applying the
      // guard here would make every self-started watch silently never fire. The one-shot disarm above is what bounds
      // the loop instead.
      const matched = waiting.filter((s) => s.wakeIntent && wakeIntentMatches(s.wakeIntent, event));
      let resumed = 0;
      for (const session of matched) if (await resume(session, event)) resumed += 1;
      return resumed;
    },
    async sweep(now, limit) {
      if (!deps.keyStore) return 0;
      const expired = await deps.chat.sessions.listExpiredWakeIntents(now, { limit: limit ?? 20 });
      let resumed = 0;
      for (const session of expired) if (await resume(session, undefined)) resumed += 1;
      return resumed;
    },
  };
}
