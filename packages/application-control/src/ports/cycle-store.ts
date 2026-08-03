import type { CycleRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface CycleListFilter {
  teamId?: string;
  // Only the iterations still open — what a planning screen shows. "Completed" is the explicit close, not a
  // passed end date, so this is a NULL test rather than a date comparison.
  open?: boolean;
  limit?: number;
}

// A team's iterations. `events` is the E0 outbox, the same contract every other tracker store holds: the state
// change and the fact describing it commit together.
export interface CycleStore {
  create(record: CycleRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<CycleRecord | undefined>;
  list(tenant: string, filter?: CycleListFilter): Promise<CycleRecord[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<CycleRecord>,
    events?: OutboxEvent[],
  ): Promise<CycleRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
