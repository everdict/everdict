import type { UsageCost, UsageRow, UsageSource } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Durable usage accounting for the meter-only billing surface (docs/architecture/usage-metering.md). The in-memory
// UsageMeter (@everdict/backends) write-throughs here and hydrates from it at boot. db depends on core only — the
// meter/source vocabulary is mirrored, not imported.

// The row/source shapes now live in contracts/records — re-architecture P2c; db keeps compat re-exports (removed in the P4 sweep).
export type { UsageCost, UsageRow, UsageSource } from "@everdict/contracts";
// The store port now lives in @everdict/application-control — re-architecture P2c compat re-export (removed in the P4 sweep).
export type { UsageStore } from "@everdict/application-control";
import type { UsageStore } from "@everdict/application-control";

function coerceSource(s: string): UsageSource {
  return s === "judge" ? "judge" : s === "agent" ? "agent" : "harness";
}

export class InMemoryUsageStore implements UsageStore {
  private readonly rows = new Map<string, UsageRow>();
  private key(tenant: string, source: UsageSource, model: string, day: string): string {
    return [tenant, source, model, day].join(" ");
  }
  async record(
    tenant: string,
    source: UsageSource,
    model: string,
    day: string,
    cost: UsageCost,
    evaluations: number,
  ): Promise<void> {
    const k = this.key(tenant, source, model, day);
    const r = this.rows.get(k) ?? { tenant, source, model, day, usd: 0, tokens: 0, evaluations: 0 };
    r.usd += cost.usd;
    r.tokens += cost.tokens;
    r.evaluations += evaluations;
    this.rows.set(k, r);
  }
  async all(): Promise<UsageRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

// Postgres — atomic increment via ON CONFLICT DO UPDATE (concurrent writes to the same (tenant,source,model,day) accumulate).
export class PgUsageStore implements UsageStore {
  constructor(private readonly sql: SqlClient) {}
  async record(
    tenant: string,
    source: UsageSource,
    model: string,
    day: string,
    cost: UsageCost,
    evaluations: number,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO everdict_usage (tenant, source, model, day, usd, tokens, evaluations, updated_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, now())
       ON CONFLICT (tenant, source, model, day) DO UPDATE SET
         usd = everdict_usage.usd + EXCLUDED.usd,
         tokens = everdict_usage.tokens + EXCLUDED.tokens,
         evaluations = everdict_usage.evaluations + EXCLUDED.evaluations,
         updated_at = now()`,
      [tenant, source, model, day, cost.usd, cost.tokens, evaluations],
    );
  }
  async all(): Promise<UsageRow[]> {
    // Numeric columns come back as strings from pg — coerce. (usd double precision, tokens/evaluations bigint.)
    // `day` is selected as text so the row carries the plain YYYY-MM-DD form (pg would otherwise parse a Date).
    const { rows } = await this.sql.query<{
      tenant: string;
      source: string;
      model: string;
      day: string;
      usd: string | number;
      tokens: string | number;
      evaluations: string | number;
    }>("SELECT tenant, source, model, to_char(day, 'YYYY-MM-DD') AS day, usd, tokens, evaluations FROM everdict_usage");
    return rows.map((r) => ({
      tenant: r.tenant,
      source: coerceSource(r.source),
      model: r.model,
      day: r.day,
      usd: Number(r.usd),
      tokens: Number(r.tokens),
      evaluations: Number(r.evaluations),
    }));
  }
}
