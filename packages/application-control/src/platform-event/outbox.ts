import type { DomainFact } from "@everdict/contracts";
import type { OutboxEvent } from "../ports/run-store.js";
import { projectRecipient, renderFactMessage } from "./fact-projection.js";

// A domain fact stamped with identity, ready for the outbox: the row the store persists in the same
// transaction as the aggregate write, plus the push envelope (recipient rides the live push only —
// it is a delivery concern, never part of the persisted record).
export interface StampedFact {
  record: OutboxEvent;
  recipient?: string;
}

// Stamp identity (id/tenant/createdAt) AND presentation onto domain facts — facts are born UNSTAMPED and
// UNRENDERED inside aggregate transitions (the domain owns legality and the semantic payload; the service
// owns identity, clock, and the projection — fact-projection.ts renders the message and the push recipient
// here, at the one choke point every aggregate's facts pass through). An application-authored fact may
// carry its own message/recipient (the application IS the projection layer); a domain fact never does.
// The SAME ids then travel the pushPersisted path, so consumer dedup holds whether an event arrives by
// push or by cursor. Shared by every aggregate that emits through the outbox (Run, ScorecardBatch, …).
export function stampFacts(
  tenant: string,
  facts: Array<DomainFact & { message?: string; recipient?: string }>,
  ids: { newId: () => string; now: () => string },
): StampedFact[] {
  return facts.map((f) => {
    const recipient = f.recipient ?? projectRecipient(f);
    return {
      record: {
        id: ids.newId(),
        tenant,
        kind: f.kind,
        subject: f.subject,
        ...(f.actor !== undefined ? { actor: f.actor } : {}),
        payload: f.payload ?? {},
        ...(f.causedBy !== undefined ? { causedBy: f.causedBy } : {}),
        message: f.message ?? renderFactMessage(f),
        createdAt: ids.now(),
      },
      ...(recipient !== undefined ? { recipient } : {}),
    };
  });
}
