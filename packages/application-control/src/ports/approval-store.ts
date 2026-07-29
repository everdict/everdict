import type { ApprovalRecord, ApprovalStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// Durable agent-approval ledger (agent-automation A6). in-memory (dev/test) or Postgres — swapped behind the
// same interface. `events`: E0 outbox rows persisted ATOMICALLY with the write (same contract as RunStore).
export interface ApprovalListFilter {
  status?: ApprovalStatus;
  sessionId?: string;
}

export interface ApprovalStore {
  create(record: ApprovalRecord, events?: OutboxEvent[]): Promise<void>;
  update(id: string, patch: Partial<ApprovalRecord>, events?: OutboxEvent[]): Promise<ApprovalRecord | undefined>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  list(tenant: string, filter?: ApprovalListFilter): Promise<ApprovalRecord[]>;
}
