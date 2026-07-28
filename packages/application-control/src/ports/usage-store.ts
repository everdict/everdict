import type { UsageCost, UsageRow, UsageSource } from "@everdict/contracts";

export interface UsageStore {
  // Atomic per-(tenant, source, model, day) increment. Concurrent records accumulate correctly (never
  // last-write-wins). `day` is the UTC day (YYYY-MM-DD) the cost landed on — the caller stamps it once so the
  // durable row and the in-memory meter agree across a midnight boundary.
  record(
    tenant: string,
    source: UsageSource,
    model: string,
    day: string,
    cost: UsageCost,
    evaluations: number,
  ): Promise<void>;
  // Every accumulated row — used to hydrate the in-memory meter at boot.
  all(): Promise<UsageRow[]>;
}
