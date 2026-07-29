import type { EnvelopeSpend, EnvelopeStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

export class InMemoryEnvelopeStore implements EnvelopeStore {
  private readonly rows = new Map<string, EnvelopeSpend>();

  async admit(id: string, _tenant: string, runs: number): Promise<void> {
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
  }

  async settle(id: string, _tenant: string, usd: number): Promise<void> {
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    this.rows.set(id, { ...cur, usd: cur.usd + usd });
  }

  async spend(id: string): Promise<EnvelopeSpend> {
    return this.rows.get(id) ?? { usd: 0, runs: 0 };
  }
}

// Postgres-backed envelope ledger (mig 0096) — an upsert per settle/admit; the headroom check reads one row.
export class PgEnvelopeStore implements EnvelopeStore {
  constructor(private readonly client: SqlClient) {}

  async admit(id: string, tenant: string, runs: number): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_envelopes (id, tenant, spent_usd, admitted_runs, updated_at)
       VALUES ($1, $2, 0, $3, now())
       ON CONFLICT (id) DO UPDATE SET admitted_runs = everdict_envelopes.admitted_runs + $3, updated_at = now()`,
      [id, tenant, runs],
    );
  }

  async settle(id: string, tenant: string, usd: number): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_envelopes (id, tenant, spent_usd, admitted_runs, updated_at)
       VALUES ($1, $2, $3, 0, now())
       ON CONFLICT (id) DO UPDATE SET spent_usd = everdict_envelopes.spent_usd + $3, updated_at = now()`,
      [id, tenant, usd],
    );
  }

  async spend(id: string): Promise<EnvelopeSpend> {
    const res = await this.client.query<{ spent_usd: number; admitted_runs: number }>(
      "SELECT spent_usd, admitted_runs FROM everdict_envelopes WHERE id = $1",
      [id],
    );
    const row = res.rows[0];
    return row ? { usd: Number(row.spent_usd), runs: Number(row.admitted_runs) } : { usd: 0, runs: 0 };
  }
}
