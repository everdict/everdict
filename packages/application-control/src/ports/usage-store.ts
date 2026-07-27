import type { UsageCost, UsageRow, UsageSource } from "@everdict/contracts";

export interface UsageStore {
  // Atomic per-(tenant, source, model) increment. Concurrent records accumulate correctly (never last-write-wins).
  record(tenant: string, source: UsageSource, model: string, cost: UsageCost, evaluations: number): Promise<void>;
  // Every accumulated row — used to hydrate the in-memory meter at boot.
  all(): Promise<UsageRow[]>;
}
