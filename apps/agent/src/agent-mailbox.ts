import type { ChatMessage } from "@everdict/agent-runtime";
import type { AgentSessionStore } from "@everdict/application-control";
import type { AgentInboxEntry, AgentInboxSource, ReadResult } from "@everdict/contracts";
import { readOrUnknown } from "@everdict/contracts";

// The message substrate (S1 of docs/architecture/agent-teams.md) — one envelope, many sources. A user steering note, a
// teammate's message, and a monitoring event are the same kind of thing: an addressed message with a sender. The
// running turn drains its mailbox at each turn boundary (via the loop's drainInput seam) and the messages are rendered
// with attribution so the model knows who is speaking.
//
// ── IT IS A DURABLE ORDERED LOG, NOT A MAP (DEFAUL-37) ───────────────────────────────────────────────
//
// This was `Map<string, MailboxEnvelope[]>` in this process, and the doc said so: "a message not yet drained does
// not survive an agent-service restart". The asymmetry that made it a defect rather than a limitation is that the
// ROSTER's durable half already survived — `AgentSessionRecord.teammate` is re-registered on boot, the token
// re-minted — so a restart brought the worker back and dropped what it had been told. A real-time loop holding one
// objective over hours had its central channel as the volatile part.
//
// ⚠️ THE ORCHESTRATOR DOES NOT RE-SEND. A channel whose correctness depends on the caller remembering what it
// already said only works while every caller is a process that survived, which is the case the channel exists for.
// So the row is written first and the delivery state is a column: `enqueue` returns the store's receipt, and the
// caller may answer "queued" only on the strength of it.
export type MessageFrom = AgentInboxSource;

export interface MailboxEnvelope {
  from: MessageFrom;
  sender?: string; // teammate name / event source; omitted for a plain user message
  content: string;
}

// What the store said when it took the message: the seq it assigned, which is also this channel's ordering token.
// A sender that holds X's receipt before sending Y has "X before Y" as a fact rather than a hope.
export interface MailboxReceipt {
  seq: number;
  at: string;
}

// ── A DRAIN THAT FAILED IS NOT AN EMPTY MAILBOX ──────────────────────────────────────────────────────
//
// Making the channel durable moves the drain from a Map lookup (which cannot fail) to a store read (which can),
// and the shape that would undo the whole change is `.catch(() => [])`: the turn would proceed as though nobody
// had said anything, which is exactly the state this issue exists to abolish — except now it would happen while
// the instruction sat readable in a table. So the drain is three-valued and its consumer names the case
// (rule `protocol` L2).
export type MailboxDrain = ReadResult<ChatMessage[]>;

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

function toEnvelope(entry: AgentInboxEntry): MailboxEnvelope {
  return {
    from: entry.from,
    ...(entry.sender !== undefined ? { sender: entry.sender } : {}),
    content: entry.content,
  };
}

export class AgentMailbox {
  constructor(
    private readonly store: Pick<
      AgentSessionStore,
      "appendInbox" | "claimInbox" | "discardInbox" | "listQueuedInboxSessions"
    >,
    private readonly now: () => string,
  ) {}

  // Deliver a message to a session's mailbox and return the store's receipt. AWAITED by every caller before it
  // reports the message queued — a `202 { queued: true }` sent ahead of the write is a promise this process
  // cannot keep across its own restart.
  async enqueue(workspace: string, sessionId: string, envelope: MailboxEnvelope): Promise<MailboxReceipt> {
    const stored = await this.store.appendInbox(
      {
        tenant: workspace,
        sessionId,
        from: envelope.from,
        ...(envelope.sender !== undefined ? { sender: envelope.sender } : {}),
        content: envelope.content,
      },
      this.now(),
    );
    return { seq: stored.seq, at: stored.at };
  }

  // Convenience for the common case: a user steering message (rendered verbatim, no attribution prefix).
  enqueueUser(workspace: string, sessionId: string, content: string): Promise<MailboxReceipt> {
    return this.enqueue(workspace, sessionId, { from: "user", content });
  }

  // Claim and render everything queued for a session — the loop's drainInput calls this at each turn boundary.
  // The claim is atomic in the store, so a wake racing a boundary cannot absorb the same instruction twice.
  async drain(workspace: string, sessionId: string): Promise<MailboxDrain> {
    const read = await readOrUnknown(
      () => this.store.claimInbox(workspace, sessionId, this.now()),
      `draining the steering log for session ${sessionId}`,
    );
    if (read.kind !== "read") return read;
    return { kind: "read", value: read.value.map((entry) => renderEnvelope(toEnvelope(entry))) };
  }

  // Take whatever is still queued WITHOUT delivering it — the turn being stopped will never absorb these, and
  // leaving them would silently prepend them to some future turn (a message the member cancelled, reappearing
  // inside an unrelated answer). The rows are ENDED as `discarded` rather than deleted, so a later reader can
  // still tell "the supervisor took it back" from "it is still waiting". The caller hands the user's own
  // messages back so they land in the composer instead of vanishing.
  async clear(workspace: string, sessionId: string): Promise<ReadResult<MailboxEnvelope[]>> {
    const read = await readOrUnknown(
      () => this.store.discardInbox(workspace, sessionId, this.now()),
      `clearing the steering log for session ${sessionId}`,
    );
    if (read.kind !== "read") return read;
    return { kind: "read", value: read.value.map(toEnvelope) };
  }

  // Which sessions came back from a restart holding unread instructions. The boot restore asks this so a
  // restored teammate is WOKEN for what it was told while it was gone — durability nobody reads is a table.
  queuedSessions(limit?: number): Promise<{ tenant: string; sessionId: string; queued: number }[]> {
    return this.store.listQueuedInboxSessions(limit !== undefined ? { limit } : undefined);
  }
}

// ── THE drainInput SEAM, WITH ITS THIRD CASE NAMED ───────────────────────────────────────────────────
//
// One owner, because every turn entry point needs the same answer to "what does an unreadable channel mean"
// and three spellings of it would disagree the first time it happened. `unknown` does NOT become an empty
// drain: the turn is aborted, and the rows stay queued for the next one — an agent that cannot hear its
// supervisor must stop, not continue on the last thing it heard.
export function mailboxDrainInput(
  mailbox: AgentMailbox,
  workspace: string,
  sessionId: string,
  onUnreadable: (reason: string) => void,
): () => Promise<ChatMessage[]> {
  return async () => {
    const drained = await mailbox.drain(workspace, sessionId);
    switch (drained.kind) {
      case "read":
        return drained.value;
      case "absent":
        return [];
      case "unknown":
        onUnreadable(drained.reason);
        return [];
    }
  };
}
