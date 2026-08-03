import type { IssueLabelRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// The workspace's label registry (docs/tracker.md). `events` is the E0 outbox: implementations persist facts
// ATOMICALLY with the write they describe, the same contract IssueStore and TeamStore hold.
export interface IssueLabelStore {
  // Rejects a duplicate name (case-insensitive, per workspace) with a ConflictError — the uniqueness is the
  // store's to guarantee, because two members defining "flaky" at the same moment is a concurrency question.
  create(record: IssueLabelRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<IssueLabelRecord | undefined>;
  // Case-insensitive lookup by name — the entry point a GitHub import uses to map a remote label onto the
  // registry before it decides whether to create one.
  getByName(tenant: string, name: string): Promise<IssueLabelRecord | undefined>;
  list(tenant: string): Promise<IssueLabelRecord[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<IssueLabelRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueLabelRecord | undefined>;
  // Deletes the label AND strips its id from every issue that wears it, in ONE transaction. That atomicity is
  // the whole reason this lives on the store rather than in the service: a `labelIds` array must never be able
  // to point at a label that no longer exists. Returns false when the label was already gone.
  remove(tenant: string, id: string, events?: OutboxEvent[]): Promise<boolean>;
  // How many issues currently wear this label — what the delete confirmation shows before it strips them.
  usageCount(tenant: string, id: string): Promise<number>;
}
