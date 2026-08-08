// The durable answer to "how much is this workspace running RIGHT NOW, across the whole control plane".
//
// The Scheduler's own admission counters are per-process maps: they count only what THIS replica happens to
// hold, so a deployment running N api replicas admits every tenant quota N times over. That regression already
// happened once on the session pool ("a 3-instance deployment gave every workspace three times the pool",
// SandboxSessionService.enforceCapacity) and the fix there is the pattern here: the count is DERIVED from the
// run ledger — never a counter to reconcile — so a tombstoned run frees its slot by being terminal.
//
// Deliberately thin: one grouped read per scheduler drain, the same budget as the one cluster capacity probe a
// drain already makes. `RunStore` extends it, so the control plane hands the Scheduler the ledger it already has.
export interface AdmissionLedger {
  // Fleet-wide in-flight EVAL execution keyed by tenant. What counts is deliberately narrow: rows that are
  // `running` (not `queued` — a job still waiting in some replica's queue must not count against the quota that
  // decides whether it may start, or a tenant at quota deadlocks itself), of the eval family (a legacy row with
  // no `kind` is an eval run), and task-shaped (a held-open session is bounded by the session pool's own cap,
  // not by the scheduler quota — counting worlds here would let three open sandboxes block a workspace's evals).
  // A tenant with nothing in flight may be absent rather than 0.
  inFlightByTenant(): Promise<Record<string, number>>;
  // ── HARD quota admission (TRUST-07) ──
  // `inFlightByTenant` is a SNAPSHOT: two replicas reading the same headroom in the same instant both admit,
  // so on its own the quota is eventually consistent — a fairness signal, not a limit. `tryAdmit` is the
  // limit: an ATOMIC fleet-wide permit (the Pg impl claims a per-tenant counter row whose UPDATE re-evaluates
  // its `in_flight < quota` predicate on the LATEST row version under the row lock — the one single-statement
  // shape READ COMMITTED makes race-proof), so the same-instant double-admit window is closed. The permit is
  // job-keyed for an idempotent `releaseAdmission`, and CONSERVED: a retry with the same permit id is the
  // same right (answered as held, never claimed twice), so the counter always equals the live permit rows.
  // Optional: an in-memory single-process wiring is its own serialization already.
  tryAdmit?(tenant: string, permitId: string, quota: number): Promise<boolean>;
  releaseAdmission?(permitId: string): Promise<void>;
  // A permit is a LEASE, not a timestamp: the scheduler renews the permits of work it is still running, and
  // the ledger's reap frees only permits whose lease lapsed. The claim, stated exactly: CRASH-recoverable —
  // a dead replica stops renewing and heals within the window — and never reaping a healthy renewing run.
  // NOT partition-fenced: a holder cut off from the ledger but not from its orchestrator keeps driving
  // compute while its renewals fail, and after the window the fleet can briefly exceed the quota by that
  // holder's share. Fencing (renewal-failure self-kill / fenced execution tokens) is the named next step if
  // hard-under-partition is ever required.
  renewAdmissions?(permitIds: string[]): Promise<void>;
}
