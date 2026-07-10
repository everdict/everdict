import type { BudgetLimitRow, BudgetUsageRow } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Durable per-tenant budgets. The in-memory BudgetTracker (@everdict/backends) enforces synchronously and
// write-throughs here (best-effort), hydrating from it at boot so caps survive a control-plane restart. Two kinds of
// state: usage counters (reserved runs + committed cost) and per-tenant limit config. db depends on core only — the
// budget vocabulary is mirrored, not imported.

import type { BudgetStore } from "@everdict/application-control";

function limitRow(tenant: string, limit: { usd?: number; tokens?: number; runs?: number }): BudgetLimitRow {
  return {
    tenant,
    ...(limit.usd !== undefined ? { usd: limit.usd } : {}),
    ...(limit.tokens !== undefined ? { tokens: limit.tokens } : {}),
    ...(limit.runs !== undefined ? { runs: limit.runs } : {}),
  };
}

export class InMemoryBudgetStore implements BudgetStore {
  private readonly usage = new Map<string, BudgetUsageRow>();
  private readonly limits = new Map<string, BudgetLimitRow>();

  async addUsage(tenant: string, delta: { runs?: number; usd?: number; tokens?: number }): Promise<void> {
    const r = this.usage.get(tenant) ?? { tenant, runs: 0, usd: 0, tokens: 0 };
    r.runs = Math.max(0, r.runs + (delta.runs ?? 0));
    r.usd += delta.usd ?? 0;
    r.tokens += delta.tokens ?? 0;
    this.usage.set(tenant, r);
  }
  async allUsage(): Promise<BudgetUsageRow[]> {
    return [...this.usage.values()].map((r) => ({ ...r }));
  }
  async setLimit(tenant: string, limit: { usd?: number; tokens?: number; runs?: number }): Promise<void> {
    this.limits.set(tenant, limitRow(tenant, limit));
  }
  async allLimits(): Promise<BudgetLimitRow[]> {
    return [...this.limits.values()].map((r) => ({ ...r }));
  }
}

// Postgres — usage via atomic ON CONFLICT increment (runs GREATEST(0, …) so a release can't drive it negative);
// limits via ON CONFLICT replace (a PUT overwrites all dimensions, NULL = unlimited).
export class PgBudgetStore implements BudgetStore {
  constructor(private readonly sql: SqlClient) {}

  async addUsage(tenant: string, delta: { runs?: number; usd?: number; tokens?: number }): Promise<void> {
    await this.sql.query(
      `INSERT INTO everdict_budget_usage (tenant, runs, usd, tokens, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant) DO UPDATE SET
         runs = GREATEST(0, everdict_budget_usage.runs + EXCLUDED.runs),
         usd = everdict_budget_usage.usd + EXCLUDED.usd,
         tokens = everdict_budget_usage.tokens + EXCLUDED.tokens,
         updated_at = now()`,
      [tenant, delta.runs ?? 0, delta.usd ?? 0, delta.tokens ?? 0],
    );
  }

  async allUsage(): Promise<BudgetUsageRow[]> {
    // Numeric columns come back as strings from pg — coerce. (usd double precision, runs/tokens bigint.)
    const { rows } = await this.sql.query<{
      tenant: string;
      runs: string | number;
      usd: string | number;
      tokens: string | number;
    }>("SELECT tenant, runs, usd, tokens FROM everdict_budget_usage");
    return rows.map((r) => ({ tenant: r.tenant, runs: Number(r.runs), usd: Number(r.usd), tokens: Number(r.tokens) }));
  }

  async setLimit(tenant: string, limit: { usd?: number; tokens?: number; runs?: number }): Promise<void> {
    await this.sql.query(
      `INSERT INTO everdict_budget_limits (tenant, usd, tokens, runs, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant) DO UPDATE SET
         usd = EXCLUDED.usd, tokens = EXCLUDED.tokens, runs = EXCLUDED.runs, updated_at = now()`,
      [tenant, limit.usd ?? null, limit.tokens ?? null, limit.runs ?? null],
    );
  }

  async allLimits(): Promise<BudgetLimitRow[]> {
    const { rows } = await this.sql.query<{
      tenant: string;
      usd: string | number | null;
      tokens: string | number | null;
      runs: string | number | null;
    }>("SELECT tenant, usd, tokens, runs FROM everdict_budget_limits");
    return rows.map((r) => ({
      tenant: r.tenant,
      ...(r.usd !== null ? { usd: Number(r.usd) } : {}),
      ...(r.tokens !== null ? { tokens: Number(r.tokens) } : {}),
      ...(r.runs !== null ? { runs: Number(r.runs) } : {}),
    }));
  }
}
