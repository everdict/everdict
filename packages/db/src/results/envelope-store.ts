import type { EnvelopeSpend, EnvelopeStore } from "@everdict/application-control";
import { ConflictError } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// A reused request id MUST mean the same request — a caller re-presenting a held id with a different
// envelope or a different run count is not retrying, it is spending under someone else's receipt (claim 1
// run, "retry" with 100: the pre-fix held answer never re-checked the payload, a cap bypass).
function assertSameRequest(
  requestId: string,
  held: { envelopeId: string; runs: number },
  asked: { envelopeId: string; runs: number },
): void {
  if (held.envelopeId === asked.envelopeId && held.runs === asked.runs) return;
  throw new ConflictError(
    "CONFLICT",
    { requestId, held, asked },
    `admission request '${requestId}' was already claimed for ${held.runs} run(s) on envelope '${held.envelopeId}' — the same request id cannot name a different ask`,
  );
}

export class InMemoryEnvelopeStore implements EnvelopeStore {
  private readonly rows = new Map<string, EnvelopeSpend>();
  // requestId → the PAYLOAD it was granted for (retry = the same right, verified to be the same ask).
  private readonly requests = new Map<string, { envelopeId: string; runs: number }>();

  async admit(id: string, _tenant: string, runs: number): Promise<void> {
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
  }

  // Single-process, so the synchronous check-and-claim IS the atomicity the Pg twin buys with its
  // claim-first request row. Same request vocabulary either way: a held id re-answers (same payload only),
  // a refusal records nothing (it holds no capacity and must not block a later ask).
  async tryAdmitRuns(id: string, _tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean> {
    const held = this.requests.get(requestId);
    if (held) {
      assertSameRequest(requestId, held, { envelopeId: id, runs });
      return true; // the same right, re-answered
    }
    const cur = this.rows.get(id) ?? { usd: 0, runs: 0 };
    if (cur.runs + runs > capRuns) return false;
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
    this.requests.set(requestId, { envelopeId: id, runs });
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

  // CONSERVATION (mig 0141/0145): admitted_runs == Σ granted request rows. CLAIM-FIRST: the request row's
  // unique index is the serialization point — the mig-0141 single statement probed request existence and
  // wrote the row FROM the counter claim, so two concurrent calls with the same request id both passed the
  // (empty) probe and both incremented the counter: one right, charged twice. Now the claim upsert either
  // INSERTS the row with the decision pending (xmax = 0 → this call owns the decision) or LOCKS-and-reads
  // the existing claim (payload-verified: a held id re-answering a DIFFERENT ask is a cap bypass, refused
  // with a ConflictError). Only the owner proceeds to the decision statement, whose counter arm re-evaluates
  // the cap predicate on the LATEST row version under the row lock (READ COMMITTED EvalPlanQual), then
  // marks the claim granted or DELETES it (a refusal holds no capacity and must not block a later ask).
  // `admitted IS NULL` rows are crash residue (claimed, never decided — nothing charged, nothing granted);
  // whoever re-presents the request id takes the decision over, serialized by FOR UPDATE.
  async tryAdmitRuns(id: string, tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = await this.client.query<{
        envelope_id: string;
        runs: string | number;
        admitted: boolean | null;
        inserted: boolean;
      }>(
        `INSERT INTO everdict_envelope_admissions (request_id, envelope_id, runs, admitted)
         VALUES ($1, $2, $3::int, NULL)
         ON CONFLICT (request_id) DO UPDATE SET request_id = EXCLUDED.request_id
         RETURNING envelope_id, runs, admitted, (xmax = 0) AS inserted`,
        [requestId, id, runs],
      );
      const row = claim.rows[0];
      if (!row) return false; // unreachable (the upsert always returns one row) — fail closed
      if (!row.inserted) {
        assertSameRequest(requestId, { envelopeId: row.envelope_id, runs: Number(row.runs) }, { envelopeId: id, runs });
        if (row.admitted === true) return true; // the same right, re-answered — the counter is untouched
        // admitted IS NULL: a previous claimer crashed before deciding — fall through and decide it now.
      }
      const decide = await this.client.query<{
        pending: string | number;
        granted: string | number;
      }>(
        `WITH req AS (
           SELECT request_id, envelope_id, runs FROM everdict_envelope_admissions
            WHERE request_id = $1 AND admitted IS NULL
            FOR UPDATE
         ), counted AS (
           INSERT INTO everdict_envelopes (id, tenant, spent_usd, admitted_runs, updated_at)
           SELECT req.envelope_id, $2, 0, req.runs, now() FROM req
            WHERE req.runs <= $3::int
           ON CONFLICT (id) DO UPDATE
             SET admitted_runs = everdict_envelopes.admitted_runs + EXCLUDED.admitted_runs, updated_at = now()
             WHERE everdict_envelopes.admitted_runs + EXCLUDED.admitted_runs <= $3::int
           RETURNING id
         ), granted AS (
           UPDATE everdict_envelope_admissions a SET admitted = true
            FROM req WHERE a.request_id = req.request_id AND EXISTS (SELECT 1 FROM counted)
            RETURNING a.request_id
         ), refused AS (
           DELETE FROM everdict_envelope_admissions a
            USING req WHERE a.request_id = req.request_id AND NOT EXISTS (SELECT 1 FROM counted)
            RETURNING a.request_id
         )
         SELECT (SELECT count(*) FROM req) AS pending, (SELECT count(*) FROM granted) AS granted`,
        [requestId, tenant, capRuns],
      );
      const d = decide.rows[0];
      // A concurrent decider beat this call to the pending row (FOR UPDATE re-read found it decided or
      // deleted) — loop back: the claim re-read answers held, or re-claims a deleted (refused) row fresh.
      if (Number(d?.pending ?? 0) === 0) continue;
      return Number(d?.granted ?? 0) > 0;
    }
    return false; // three straight decision races — fail closed rather than spin (capacity is contended anyway)
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
