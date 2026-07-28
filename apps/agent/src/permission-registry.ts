import type { PermissionDecision } from "@everdict/agent-runtime";

interface Pending {
  sessionId: string;
  name: string;
  input: unknown;
  resolve: (decision: PermissionDecision) => void;
}

// Server-wide registry of write-tool approvals awaiting a human decision. The SSE chat stream registers a pending
// request (emitting a `permission` event to the web, which shows an approve/deny prompt) and awaits it; the separate
// POST /permission route resolves it. A client disconnect or a timeout resolves to "deny" — the safe default, so a
// vanished client never leaves a mutating tool auto-approved nor the loop hung forever. Background discussion turns
// have no live stream — a panel opened mid-turn discovers their asks via pendingFor() (GET /pending) and resolves
// through the same respond() channel (they pass a longer per-wait timeout since nobody may be watching yet).
export class PermissionRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 300_000) {}

  // Await a human decision for `requestId` (scoped to `sessionId`). Resolves on respond(), or "deny" on abort/timeout.
  // `request` (tool name + input) is kept so a late-attaching watcher can render the ask; `timeoutMs` overrides the
  // registry default (background turns opt into a longer park).
  wait(
    requestId: string,
    sessionId: string,
    signal?: AbortSignal,
    request?: { name: string; input: unknown },
    timeoutMs?: number,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      let settled = false;
      const finish = (decision: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve(decision);
      };
      const timer = setTimeout(() => finish("deny"), timeoutMs ?? this.timeoutMs);
      signal?.addEventListener("abort", () => finish("deny"), { once: true });
      this.pending.set(requestId, {
        sessionId,
        name: request?.name ?? "",
        input: request?.input,
        resolve: finish,
      });
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

  // The session's parked asks — lets a panel opened DURING a background turn discover and answer them.
  pendingFor(sessionId: string): { requestId: string; name: string; input: unknown }[] {
    return [...this.pending.entries()]
      .filter(([, p]) => p.sessionId === sessionId)
      .map(([requestId, p]) => ({ requestId, name: p.name, input: p.input }));
  }
}
