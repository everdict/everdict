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
}
