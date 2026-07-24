import type { ChatMessage } from "@everdict/agent-runtime";

// The message substrate (S1 of docs/architecture/agent-teams.md) — one envelope, many sources. A user steering note, a
// teammate's message, and a monitoring event are the same kind of thing: an addressed message with a sender. The
// running turn drains its mailbox at each turn boundary (via the loop's drainInput seam) and the messages are rendered
// with attribution so the model knows who is speaking. In-memory + per (workspace, session); the durable/cross-process
// bus is a later stage — this is the nascent, source-agnostic mailbox the single-agent InputQueue generalized into.
export type MessageFrom = "user" | "agent" | "event";

export interface MailboxEnvelope {
  from: MessageFrom;
  sender?: string; // teammate name / event source; omitted for a plain user message
  content: string;
}

// Render an envelope into the ChatMessage the loop injects, attributed by source so the model can tell a user steering
// note from a teammate message from a platform event.
export function renderEnvelope(envelope: MailboxEnvelope): ChatMessage {
  if (envelope.from === "user") return { role: "user", content: envelope.content };
  if (envelope.from === "agent") {
    return {
      role: "user",
      content: `[Message from teammate ${envelope.sender ?? "another agent"}]\n${envelope.content}`,
    };
  }
  return {
    role: "user",
    content: `[Everdict event${envelope.sender ? ` — ${envelope.sender}` : ""}]\n${envelope.content}`,
  };
}

export class AgentMailbox {
  private readonly boxes = new Map<string, MailboxEnvelope[]>();

  private keyOf(workspace: string, sessionId: string): string {
    return `${workspace}:${sessionId}`;
  }

  // Deliver a message to a session's mailbox. No-op-safe if nothing is running (it waits to be drained).
  enqueue(workspace: string, sessionId: string, envelope: MailboxEnvelope): void {
    const key = this.keyOf(workspace, sessionId);
    const existing = this.boxes.get(key);
    if (existing) existing.push(envelope);
    else this.boxes.set(key, [envelope]);
  }

  // Convenience for the common case: a user steering message (rendered verbatim, no attribution prefix).
  enqueueUser(workspace: string, sessionId: string, content: string): void {
    this.enqueue(workspace, sessionId, { from: "user", content });
  }

  // Take and clear all queued messages for a session, rendered to ChatMessages — the loop's drainInput calls this at
  // each turn boundary.
  drain(workspace: string, sessionId: string): ChatMessage[] {
    const key = this.keyOf(workspace, sessionId);
    const queued = this.boxes.get(key);
    if (!queued || queued.length === 0) return [];
    this.boxes.delete(key);
    return queued.map(renderEnvelope);
  }
}
