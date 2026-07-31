// Server-wide registry of LIVE chat turns, keyed by (workspace, session). POST /chat registers the turn when it
// starts the loop and the turn lives until the loop settles — INDEPENDENT of the HTTP response that started it:
// every SSE write goes through broadcast() and responses are just subscribers, so a client disconnect (the web
// switching conversations, an infra-tab unmount) merely detaches a subscriber while the loop keeps running.
// GET /stream re-attaches (snapshot() replays what the attacher missed); POST /stop is the explicit abort — the
// old "disconnect = stop" coupling is gone. One live turn per session: begin() is the atomic claim, so a second
// /chat on the same session is refused with 409 (the duplicate-turn guard).

export type LiveTurnListener = (event: string, data: unknown) => void;

// What a late attacher replays before subscribing: the in-flight assistant bubble (deltas since the last
// persisted assistant record — persisted records themselves come from GET /messages) and a presented plan still
// awaiting approval. Parked write-tool asks are replayed from the PermissionRegistry, not here.
export interface LiveTurnSnapshot {
  streamingText: string;
  streamingReasoning: string;
  pendingPlan?: { requestId: string; plan: string };
  // An in-progress retry wait (the loop is backing off a transient model failure — up to minutes under
  // persistent mode). Replayed so a late attacher sees WHY the turn is quiet instead of a frozen panel;
  // cleared by the next progress event (delta/reasoning/message).
  pendingRetry?: { attempt: number; delayMs: number; persistent?: boolean };
}

interface LiveTurn {
  controller: AbortController;
  listeners: Set<LiveTurnListener>;
  streamingText: string;
  streamingReasoning: string;
  // 명시적 undefined 리셋(plan 결정 후)을 위해 required | undefined 로 둔다 (delete 금지 규칙).
  pendingPlan: { requestId: string; plan: string } | undefined;
  pendingRetry: { attempt: number; delayMs: number; persistent?: boolean } | undefined;
  // The loop's soft-interrupt trigger (parked via setInterrupt once the turn's loop starts). Aborts only the
  // in-flight STEP — with queued input the turn continues redirected; bare it ends "interrupted". stop() stays
  // the whole-turn abort.
  interrupt: (() => void) | undefined;
}

function textOf(data: unknown): string {
  if (data !== null && typeof data === "object" && "text" in data) {
    const text = (data as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export class LiveTurnRegistry {
  private readonly turns = new Map<string, LiveTurn>();

  private key(workspace: string, sessionId: string): string {
    return `${workspace}\u0000${sessionId}`;
  }

  // Atomically claim the session's turn slot and return its abort controller. Null = a turn is already live
  // (the caller answers 409 instead of double-running the loop).
  begin(workspace: string, sessionId: string): AbortController | null {
    const key = this.key(workspace, sessionId);
    if (this.turns.has(key)) return null;
    const controller = new AbortController();
    this.turns.set(key, {
      controller,
      listeners: new Set(),
      streamingText: "",
      streamingReasoning: "",
      pendingPlan: undefined,
      pendingRetry: undefined,
      interrupt: undefined,
    });
    return controller;
  }

  isLive(workspace: string, sessionId: string): boolean {
    return this.turns.has(this.key(workspace, sessionId));
  }

  // The in-flight state a late attacher replays before subscribing. Null = nothing live (the caller 204s).
  snapshot(workspace: string, sessionId: string): LiveTurnSnapshot | null {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return null;
    return {
      streamingText: turn.streamingText,
      streamingReasoning: turn.streamingReasoning,
      ...(turn.pendingPlan ? { pendingPlan: turn.pendingPlan } : {}),
      ...(turn.pendingRetry ? { pendingRetry: turn.pendingRetry } : {}),
    };
  }

  // Subscribe to the live turn's event feed. Returns the detach fn, or null when nothing is live. Detaching
  // never aborts the turn — stopping is stop()'s job.
  attach(workspace: string, sessionId: string, listener: LiveTurnListener): (() => void) | null {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return null;
    turn.listeners.add(listener);
    return () => turn.listeners.delete(listener);
  }

  // Fan an SSE event to every subscriber and keep the replay buffers current: deltas grow the in-flight bubble;
  // a persisted assistant record retires it (the exact rule the web applies to its own live buffers); a plan ask
  // parks for replay until the loop reports it presented+decided. A throwing listener is dropped so one dead
  // socket can't break the fan-out for the rest.
  broadcast(workspace: string, sessionId: string, event: string, data: unknown): void {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return;
    if (event === "delta") {
      turn.streamingText += textOf(data);
      turn.pendingRetry = undefined; // progress — the wait is over
    } else if (event === "reasoning") {
      turn.streamingReasoning += textOf(data);
      turn.pendingRetry = undefined;
    } else if (event === "message") {
      const record = data as { role?: unknown; content?: unknown };
      turn.pendingRetry = undefined;
      if (record.role === "assistant") {
        turn.streamingReasoning = "";
        if (typeof record.content === "string" && record.content.trim().length > 0) turn.streamingText = "";
      }
    } else if (event === "retry") {
      // Park the in-progress wait for replay (the latest ask wins — attempts supersede each other).
      const wait = data as { attempt?: unknown; delayMs?: unknown; persistent?: unknown };
      if (typeof wait.attempt === "number" && typeof wait.delayMs === "number")
        turn.pendingRetry = {
          attempt: wait.attempt,
          delayMs: wait.delayMs,
          ...(wait.persistent === true ? { persistent: true } : {}),
        };
    } else if (event === "fallback") {
      // The fallback call starts immediately — the retry wait it superseded is no longer in progress.
      turn.pendingRetry = undefined;
    } else if (event === "plan") {
      const ask = data as { requestId?: unknown; plan?: unknown };
      if (typeof ask.requestId === "string" && typeof ask.plan === "string")
        turn.pendingPlan = { requestId: ask.requestId, plan: ask.plan };
    } else if (event === "plan_presented") {
      // The post-decision event — the parked plan ask is settled, so a late attacher must not re-see it.
      turn.pendingPlan = undefined;
    }
    for (const listener of [...turn.listeners]) {
      try {
        listener(event, data);
      } catch {
        turn.listeners.delete(listener);
      }
    }
  }

  // Park the loop's soft-interrupt trigger for this turn (wired from the chat route's onInterruptReady).
  setInterrupt(workspace: string, sessionId: string, interrupt: () => void): void {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return;
    turn.interrupt = interrupt;
  }

  // Soft-interrupt the live turn (POST /interrupt): abort only the in-flight step — the loop survives and
  // either continues redirected (input was queued) or ends "interrupted". False = nothing live / the loop has
  // not parked its trigger yet (the caller 404s/409s rather than pretending).
  interrupt(workspace: string, sessionId: string): boolean {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn || !turn.interrupt) return false;
    turn.interrupt();
    return true;
  }

  // Abort the live turn (POST /stop). False = nothing live for that session.
  stop(workspace: string, sessionId: string): boolean {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return false;
    turn.controller.abort();
    return true;
  }

  // The turn settled (its terminal done/error was already broadcast) — release the slot. Safe to call for a
  // session that never registered (the unknown-session chat path).
  end(workspace: string, sessionId: string): void {
    const turn = this.turns.get(this.key(workspace, sessionId));
    if (!turn) return;
    turn.listeners.clear();
    this.turns.delete(this.key(workspace, sessionId));
  }
}
