// Metered-usage record shapes — moved from @everdict/db usage-store in re-architecture P2c.
// The UsageStore interface + impls stay in @everdict/db.
// Where a metered LLM cost came from: the harness under test, the eval/judge model, or an agent conversation.
export type UsageSource = "harness" | "judge" | "agent";

export interface UsageCost {
  usd: number;
  tokens: number;
}

// One accumulated (tenant, source, model) row — the durable form of a tenant's metered usage. all() hydrates the
// meter. `model` is the underlying model string the cost was billed against ("" = legacy/unattributed) — it makes
// usage itemizable as a (source × model) matrix, so a workspace sees which model each activity spent on.
export interface UsageRow {
  tenant: string;
  source: UsageSource;
  model: string;
  usd: number;
  tokens: number;
  evaluations: number;
}
