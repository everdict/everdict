// Per-tenant budget record shapes — moved from @everdict/db budget-store in re-architecture P2c.
// The BudgetStore interface + impls stay in @everdict/db.

// Accumulated usage for one tenant — the durable form of BudgetUsage. allUsage() hydrates the tracker.
export interface BudgetUsageRow {
  tenant: string;
  runs: number; // reserved+committed run count (admit +1 / release -1), floored at 0
  usd: number;
  tokens: number;
}

// A per-tenant limit; an undefined dimension = unlimited on that axis (a NULL column in Postgres).
export interface BudgetLimitRow {
  tenant: string;
  usd?: number;
  tokens?: number;
  runs?: number;
}
