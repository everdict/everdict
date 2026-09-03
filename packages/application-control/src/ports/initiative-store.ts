import type { InitiativeRecord, InitiativeStatus, InitiativeUpdateRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface InitiativeListFilter {
  status?: InitiativeStatus;
  limit?: number;
  // The dashboard's set filter — see `ProjectListFilter.statuses` (perf review). Empty array = chosen and
  // nothing matches.
  statuses?: readonly InitiativeStatus[];
}

export interface InitiativeStore {
  create(record: InitiativeRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<InitiativeRecord | undefined>;
  list(tenant: string, filter?: InitiativeListFilter): Promise<InitiativeRecord[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<InitiativeRecord>,
    events?: OutboxEvent[],
  ): Promise<InitiativeRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

// The posted-update timeline. Append-only: an update is what somebody said at a moment, so there is no edit
// path and nothing to invalidate. Same port shape as `ProjectUpdateStore`, one level up.
export interface InitiativeUpdateStore {
  create(record: InitiativeUpdateRecord): Promise<void>;
  list(tenant: string, initiativeId: string, limit?: number): Promise<InitiativeUpdateRecord[]>;
}
