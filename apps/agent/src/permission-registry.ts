import type { PermissionDecision } from "@everdict/agent-runtime";

interface Pending {
  sessionId: string;
  resolve: (decision: PermissionDecision) => void;
}

// Server-wide registry of write-tool approvals awaiting a human decision. The SSE chat stream registers a pending
// request (emitting a `permission` event to the web, which shows an approve/deny prompt) and awaits it; the separate
// POST /permission route resolves it. A client disconnect or a timeout resolves to "deny" — the safe default, so a
// vanished client never leaves a mutating tool auto-approved nor the loop hung forever.
export class PermissionRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 300_000) {}

  // Await a human decision for `requestId` (scoped to `sessionId`). Resolves on respond(), or "deny" on abort/timeout.
  wait(requestId: string, sessionId: string, signal?: AbortSignal): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      let settled = false;
      const finish = (decision: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve(decision);
      };
      const timer = setTimeout(() => finish("deny"), this.timeoutMs);
      signal?.addEventListener("abort", () => finish("deny"), { once: true });
      this.pending.set(requestId, { sessionId, resolve: finish });
    });
  }

  // Resolve a pending request. Returns false if there is none (already decided / expired / unknown id) or the session
  // does not match — the caller maps that to a 404, so a stale approval can't grief another session.
  respond(requestId: string, sessionId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return false;
    entry.resolve(decision);
    return true;
  }
}
