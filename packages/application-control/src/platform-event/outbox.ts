import type { PlatformFact } from "@everdict/contracts";
import type { OutboxEvent } from "../ports/run-store.js";

// A domain fact stamped with identity, ready for the outbox: the row the store persists in the same
// transaction as the aggregate write, plus the push envelope (recipient rides the live push only —
// it is a delivery concern, never part of the persisted record).
export interface StampedFact {
  record: OutboxEvent;
  recipient?: string;
}

// Stamp identity (id/tenant/createdAt) onto domain facts — facts are born UNSTAMPED inside aggregate
// transitions (the domain owns legality; the service owns identity and clock). The SAME ids then travel
// the pushPersisted path, so consumer dedup holds whether an event arrives by push or by cursor.
// Shared by every aggregate that emits through the outbox (Run, ScorecardBatch, …).
export function stampFacts(
  tenant: string,
  facts: PlatformFact[],
  ids: { newId: () => string; now: () => string },
): StampedFact[] {
  return facts.map((f) => ({
    record: {
      id: ids.newId(),
      tenant,
      kind: f.kind,
      subject: f.subject,
      ...(f.actor !== undefined ? { actor: f.actor } : {}),
      payload: f.payload ?? {},
      ...(f.causedBy !== undefined ? { causedBy: f.causedBy } : {}),
      message: f.message,
      createdAt: ids.now(),
    },
    ...(f.recipient !== undefined ? { recipient: f.recipient } : {}),
  }));
}
