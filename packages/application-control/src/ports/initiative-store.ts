import type { InitiativeRecord, InitiativeStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface InitiativeListFilter {
  status?: InitiativeStatus;
  limit?: number;
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
