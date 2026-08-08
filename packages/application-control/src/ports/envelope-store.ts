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
  // close: two replicas at capRuns=1 both read 0, both passed, both incremented. `requestId` makes a retry
  // the SAME right (an existing request row answers held without a second increment), so
  // admitted_runs == Σ admitted request rows — conservation, certified against real Postgres.
  // Optional like the tenant ledger's tryAdmit: a store without it falls back to the advisory sequence.
  tryAdmitRuns?(id: string, tenant: string, requestId: string, runs: number, capRuns: number): Promise<boolean>;
}
