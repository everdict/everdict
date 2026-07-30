import type { SubscriptionRecord } from "@everdict/contracts";

// Subscription registry storage (event-plumbing.md E3 §6). Workspace-scoped config rows — small sets, so
// list is unpaginated like the other settings surfaces. listEnabled is the matchers' hot path (the agent
// activation engine and the E1 reaction consumer both read it per event).
export interface SubscriptionStore {
  create(record: SubscriptionRecord): Promise<void>;
  get(tenant: string, id: string): Promise<SubscriptionRecord | undefined>;
  list(tenant: string): Promise<SubscriptionRecord[]>;
  listEnabled(tenant: string): Promise<SubscriptionRecord[]>;
  update(tenant: string, id: string, patch: Partial<SubscriptionRecord>): Promise<SubscriptionRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
