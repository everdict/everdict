import type { BudgetLimitRow, BudgetUsageRow } from "@everdict/contracts";

export interface BudgetStore {
  // Atomic accumulate of a usage delta. `runs` may be negative (a release); usd/tokens only ever grow. runs floors at 0.
  addUsage(tenant: string, delta: { runs?: number; usd?: number; tokens?: number }): Promise<void>;
  allUsage(): Promise<BudgetUsageRow[]>; // every accumulated row — hydrates the in-memory tracker at boot
  // Per-tenant limit config — a PUT replaces the whole limit (unspecified dimensions become unlimited).
  setLimit(tenant: string, limit: { usd?: number; tokens?: number; runs?: number }): Promise<void>;
  allLimits(): Promise<BudgetLimitRow[]>; // every configured limit — hydrates limits at boot
}
