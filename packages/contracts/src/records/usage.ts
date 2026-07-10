// Metered-usage record shapes — moved from @everdict/db usage-store in re-architecture P2c.
// The UsageStore interface + impls stay in @everdict/db.
export type UsageSource = "harness" | "judge";

export interface UsageCost {
  usd: number;
  tokens: number;
}

// One accumulated (tenant, source) row — the durable form of a tenant's metered usage. all() hydrates the meter.
export interface UsageRow {
  tenant: string;
  source: UsageSource;
  usd: number;
  tokens: number;
  evaluations: number;
}
