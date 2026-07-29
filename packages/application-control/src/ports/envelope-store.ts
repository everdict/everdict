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
}
