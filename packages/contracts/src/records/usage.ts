// Metered-usage record shapes — moved from @everdict/db usage-store in re-architecture P2c.
// The UsageStore interface + impls stay in @everdict/db.
// Where a metered LLM cost came from: the harness under test, the eval/judge model, or an agent conversation.
export type UsageSource = "harness" | "judge" | "agent";

export interface UsageCost {
  usd: number;
  tokens: number;
}

// The day bucket rows accumulated on before daily itemization existed (migration 0088). Totals include it; the
// daily series excludes it (it is not a real day).
export const USAGE_LEGACY_DAY = "1970-01-01";

// One accumulated (tenant, source, model, day) row — the durable form of a tenant's metered usage. all() hydrates the
// meter. `model` is the underlying model string the cost was billed against ("" = legacy/unattributed) — it makes
// usage itemizable as a (source × model) matrix, so a workspace sees which model each activity spent on. `day` is the
// UTC day (YYYY-MM-DD) the cost landed on (USAGE_LEGACY_DAY = accumulated before daily itemization), so the same
// matrix is also chartable as a per-day spend series.
export interface UsageRow {
  tenant: string;
  source: UsageSource;
  model: string;
  day: string;
  usd: number;
  tokens: number;
  evaluations: number;
}
