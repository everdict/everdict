import type { HandoffCheckpointRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// Where a handoff outlives the process that wrote it (ownership protocol O6). Workspace (tenant) scoped.
// Deliberately DUMB: a checkpoint is written once and read back — no updates, no deletes. Editing a handoff
// after the fact would let a predecessor rewrite the evidence its successor already acted on, and the whole
// point of the facts/hypotheses split is that the record says what was actually known when work stopped.
//
// `events` is the E0 outbox: implementations persist facts ATOMICALLY with the write they describe, the same
// contract IssueLabelStore and TeamStore hold. The VALIDATION (dangling refs, self-verification) lives in the
// service, not here — a store that decides what is admissible is a store two callers will disagree with.
export interface HandoffCheckpointStore {
  create(record: HandoffCheckpointRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<HandoffCheckpointRecord | undefined>;
  // Newest first. `envelopeId` narrows to one task's handoffs — "how did this task stop, and what did it
  // leave", which is the question a successor arrives with.
  list(tenant: string, options?: { envelopeId?: string; limit?: number }): Promise<HandoffCheckpointRecord[]>;
}
