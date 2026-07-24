import type { ChatMessage } from "@everdict/agent-runtime";

// Mid-run user steering: while a chat turn is streaming, the web can POST additional user messages that the running
// agent loop should absorb at the next turn boundary (Claude Code's queued-message model) instead of the user having
// to Stop the whole run and resend. This in-memory, per-session FIFO buffers those messages; the loop's `drainInput`
// hook pulls (and clears) them each turn. Ephemeral by design — a delivered message is either consumed into the live
// run's context (and persisted there) or, if the run already finished, dropped and re-sent as a fresh turn by the web.
export class InputQueue {
  private readonly queues = new Map<string, ChatMessage[]>();

  private keyOf(workspace: string, sessionId: string): string {
    return `${workspace}:${sessionId}`;
  }

  // Queue a user message for an in-flight run of this session. No-op-safe if nothing is running (it simply waits to be
  // drained; the web only enqueues while a turn is streaming).
  enqueue(workspace: string, sessionId: string, content: string): void {
    const key = this.keyOf(workspace, sessionId);
    const existing = this.queues.get(key);
    const message: ChatMessage = { role: "user", content };
    if (existing) existing.push(message);
    else this.queues.set(key, [message]);
  }

  // Take and clear all queued messages for a session — the loop's drainInput calls this at each turn boundary.
  drain(workspace: string, sessionId: string): ChatMessage[] {
    const key = this.keyOf(workspace, sessionId);
    const queued = this.queues.get(key);
    if (!queued || queued.length === 0) return [];
    this.queues.delete(key);
    return queued;
  }
}
