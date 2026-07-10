import type { UsageCost, UsageRow, UsageSource } from "@everdict/contracts";

export interface UsageStore {
  // Atomic per-(tenant, source) increment. Concurrent records accumulate correctly (never last-write-wins).
  record(tenant: string, source: UsageSource, cost: UsageCost, evaluations: number): Promise<void>;
  // Every accumulated row — used to hydrate the in-memory meter at boot.
  all(): Promise<UsageRow[]>;
}
