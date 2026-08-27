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
  // ── THE TWIN CARRIES THE TENANT THE STATEMENT CARRIES (arch-review 104) ───────────────────────────
  //
  // This store took `_tenant` on all four methods and kept no tenant at all, while `releaseRuns` on the
  // Postgres side decides on `e.tenant = $3`. A twin that ignores an argument the real store filters on is
  // rule `testing`'s named blind spot, and it is invisible for as long as it stands because no fixture ever
  // passes a SECOND workspace.
  //
  // The tenant is recorded on the first write and NEVER overwritten, because that is what Postgres does: the
  // table is keyed by `id` alone and every `ON CONFLICT (id) DO UPDATE` arm sets counters, never `tenant`.
  // So the twin is not stricter than production either — admit and settle are id-keyed here exactly as they
  // are there, and only the release consults the tenant. A twin that guards MORE hides a production defect
  // just as effectively as one that guards less.
  private readonly rows = new Map<string, EnvelopeSpend & { tenant: string }>();
  // requestId → the PAYLOAD it was granted for (retry = the same right, verified to be the same ask).
  private readonly requests = new Map<string, { envelopeId: string; runs: number }>();

  private row(id: string, tenant: string): EnvelopeSpend & { tenant: string } {
    return this.rows.get(id) ?? { usd: 0, runs: 0, tenant };
  }

  async admit(id: string, tenant: string, runs: number): Promise<void> {
    const cur = this.row(id, tenant);
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
  }

  // Single-process, so the synchronous check-and-claim IS the atomicity the Pg twin buys with its
  // claim-first request row. Same request vocabulary either way: a held id re-answers (same payload only),
  // a refusal records nothing (it holds no capacity and must not block a later ask).
  async tryAdmitRuns(id: string, tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean> {
    const held = this.requests.get(requestId);
    if (held) {
      assertSameRequest(requestId, held, { envelopeId: id, runs });
      return true; // the same right, re-answered
    }
    const cur = this.row(id, tenant);
    if (cur.runs + runs > capRuns) return false;
    this.rows.set(id, { ...cur, runs: cur.runs + runs });
    this.requests.set(requestId, { envelopeId: id, runs });
    return true;
  }

  // The inverse of the claim, idempotent by request identity — see the port for why it exists. BOTH halves
  // take the same decision: a release the tenant predicate refuses consumes nothing, or the claim would be
  // spent while the capacity it holds is never given back (see `PgEnvelopeStore.releaseRuns`).
  async releaseRuns(id: string, tenant: string, requestId: string): Promise<void> {
    const held = this.requests.get(requestId);
    if (!held || held.envelopeId !== id) return; // nothing this request holds — a duplicate release is a no-op
    const cur = this.rows.get(id);
    if (cur === undefined || cur.tenant !== tenant) return; // another workspace's envelope: the WHERE clause
    this.requests.delete(requestId);
    this.rows.set(id, { ...cur, runs: Math.max(0, cur.runs - held.runs) });
  }

  async settle(id: string, tenant: string, usd: number): Promise<void> {
    const cur = this.row(id, tenant);
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

  // The inverse of the claim, in ONE statement so the row removal and the decrement cannot come apart: the
  // counter moves only for a request row this call actually deleted, which makes a duplicate release a no-op
  // rather than a refund.
  //
  // ⚠️ BOTH HALVES TAKE THE SAME DECISION, AND THEY DID NOT (arch-review 104). The `gone` DELETE matched on
  // `(request_id, envelope_id)` while the decrement additionally required `e.tenant = $3`, so a release whose
  // tenant the predicate refuses SPENT the claim and never gave the capacity back: `admitted_runs` keeps a
  // grant no request row records, the envelope is permanently that much smaller, and the honest re-release
  // finds nothing to delete and is a no-op forever. One statement that could not come apart, taking two
  // different decisions — which is the "atomic seam" law read from the other side: atomicity buys nothing
  // when the two halves disagree about whether to act.
  //
  // An `admitted = true` claim implies its envelope row exists (the decision statement inserts it in the same
  // statement that grants), so the added EXISTS never refuses a legitimate release.
  async releaseRuns(id: string, tenant: string, requestId: string): Promise<void> {
    await this.client.query(
      `WITH gone AS (
         DELETE FROM everdict_envelope_admissions a
          WHERE a.request_id = $1 AND a.envelope_id = $2 AND a.admitted = true
            AND EXISTS (SELECT 1 FROM everdict_envelopes e WHERE e.id = $2 AND e.tenant = $3)
          RETURNING a.runs
       )
       UPDATE everdict_envelopes e
          SET admitted_runs = greatest(0, e.admitted_runs - (SELECT runs FROM gone)), updated_at = now()
        WHERE e.id = $2 AND e.tenant = $3 AND EXISTS (SELECT 1 FROM gone)`,
      [requestId, id, tenant],
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
