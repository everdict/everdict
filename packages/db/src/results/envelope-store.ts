import type { EnvelopeSpend, EnvelopeStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

export class InMemoryEnvelopeStore implements EnvelopeStore {
  private readonly rows = new Map<string, EnvelopeSpend>();
  private readonly requests = new Map<string, string>(); // requestId → envelope id (retry = the same right)

  async admit(id: string, _tenant: string, runs: number): Promise<void> {
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
  }

  // Single-process, so the synchronous check-and-claim IS the atomicity the Pg twin buys with its
  // predicate-guarded upsert. Same request vocabulary either way.
  async tryAdmitRuns(id: string, _tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean> {
    if (this.requests.has(requestId)) return true; // the same right, re-answered
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    if (cur.runs + runs > capRuns) return false;
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
    this.requests.set(requestId, id);
    return true;
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

  // CONSERVATION (mig 0141): admitted_runs == Σ admitted request rows. One statement: the claim's cap
  // predicate re-evaluates on the LATEST row version under the row lock (both the fresh-row and the
  // update arm check it), the request row is written FROM the claim, and an existing request id answers
  // held without touching the counter — a lost-response retry is the same right, never a second one.
  async tryAdmitRuns(id: string, tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean> {
    const res = await this.client.query<{ held: string | number; admitted: string | number }>(
      `WITH existing AS (
         SELECT 1 FROM everdict_envelope_admissions WHERE request_id = $3
       ), claimed AS (
         INSERT INTO everdict_envelopes (id, tenant, spent_usd, admitted_runs, updated_at)
         SELECT $1, $2, 0, $4::int, now()
          WHERE $4::int <= $5::int AND NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT (id) DO UPDATE
           SET admitted_runs = everdict_envelopes.admitted_runs + $4::int, updated_at = now()
         WHERE everdict_envelopes.admitted_runs + $4::int <= $5::int
         RETURNING id
       ), request AS (
         INSERT INTO everdict_envelope_admissions (request_id, envelope_id, runs)
         SELECT $3, $1, $4::int FROM claimed
         ON CONFLICT (request_id) DO NOTHING
       )
       SELECT (SELECT count(*) FROM existing) AS held, (SELECT count(*) FROM claimed) AS admitted`,
      [id, tenant, requestId, runs, capRuns],
    );
    const row = res.rows[0];
    return Number(row?.held ?? 0) > 0 || Number(row?.admitted ?? 0) > 0;
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
