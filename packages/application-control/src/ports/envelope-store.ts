// Envelope spend ledger (execution-model §5.2, decision O7: meter + headroom + in-flight cap — never a
// reservation). One row per envelope id (= the delegating run's id): settle() meters real cost as caused
// work completes; admit() counts caused runs at the gate (the capRuns / fan-out dimension); spend() is what
// the headroom check reads. Durable on Pg (an upsert per settle), in-memory for dev/tests.
export interface EnvelopeSpend {
  usd: number;
  runs: number;
}

export interface EnvelopeStore {
  admit(id: string, tenant: string, runs: number): Promise<void>;
  settle(id: string, tenant: string, usd: number): Promise<void>;
  spend(id: string): Promise<EnvelopeSpend>;
  // ── HARD capRuns admission — the tenant-permit pattern applied to the CAUSAL budget ──
  // ONE atomic decision: claim `runs` against capRuns with the predicate re-evaluated on the LATEST row
  // version under the row lock (the same READ COMMITTED shape the tenant quota uses). The spend()-then-
  // admit() sequence this replaces was the exact count-then-check-then-increment race that shape exists to
  // close: two replicas at capRuns=1 both read 0, both passed, both incremented.
  // `requestId` names the RIGHT, claim-first and payload-bound (H6): the request row is claimed BEFORE the
  // counter moves (its unique index serializes same-id concurrency — the probe-then-write shape charged one
  // right twice), a held id re-answers WITHOUT touching the counter but ONLY for the same ask (the same id
  // re-presented with a different envelope/runs throws ConflictError — a receipt is not transferable), and
  // a refusal holds nothing (no row survives it). So admitted_runs == Σ granted request rows —
  // conservation, certified against real Postgres. Callers thread the created record's id as the natural
  // request identity, so any re-admission of the same logical creation (resume, activity retry, a lost
  // response) is the same right, never a second charge.
  // Optional like the tenant ledger's tryAdmit: a store without it falls back to the advisory sequence.
  tryAdmitRuns?(id: string, tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean>;
}
