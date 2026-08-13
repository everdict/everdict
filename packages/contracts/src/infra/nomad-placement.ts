// ── WHY NOTHING WAS PLACED, IN THE WORDS THE SCHEDULER ALREADY USED ──────────────────────────────────
//
// When Nomad cannot place a task group it creates NO allocation and records why on the evaluation
// (`FailedTGAllocs`). Every waiter in this codebase polls for an allocation, so an unplaceable job looked
// like a slow one: five minutes of polling and then "timed out waiting for the alloc to become running" —
// while the scheduler had answered in under a second, and said whether the reason was a constraint no node
// satisfies or a dimension the cluster is currently out of.
//
// It stays a DIAGNOSIS and never a decision: the wait keeps its own budget, because capacity frees up when
// another run finishes and a node with the missing attribute can join an autoscaled pool. A reason that
// cannot be fetched must never replace the timeout — it is added to it.
//
// Pure and total over the API shape, with a consumer in each of two packages that must not depend on each
// other (the placement backend and the topology runtime) — the admission test for this package.

export interface NomadPlacementMetrics {
  NodesEvaluated?: number;
  NodesFiltered?: number;
  ConstraintFiltered?: Record<string, number> | null;
  ClassFiltered?: Record<string, number> | null;
  NodesExhausted?: number;
  DimensionExhausted?: Record<string, number> | null;
  ClassExhausted?: Record<string, number> | null;
  QuotaExhausted?: string[] | null;
}

// One line naming what stopped the placement, per task group.
export function describeNomadPlacementFailure(
  failed: Record<string, NomadPlacementMetrics> | null | undefined,
): string | undefined {
  if (!failed) return undefined;
  const groups = Object.entries(failed);
  if (groups.length === 0) return undefined;
  const parts: string[] = [];
  for (const [group, metrics] of groups) {
    const reasons: string[] = [];
    // Constraints first: they are the answer whenever they are present, and the one an operator can act on
    // without touching the cluster's load ("no node has the `runsc` runtime" is a spec/cluster mismatch).
    for (const [constraint, n] of Object.entries(metrics.ConstraintFiltered ?? {})) {
      reasons.push(`${n} node(s) filtered by constraint "${constraint}"`);
    }
    for (const [cls, n] of Object.entries(metrics.ClassFiltered ?? {})) {
      reasons.push(`${n} node(s) filtered by class "${cls}"`);
    }
    for (const [dimension, n] of Object.entries(metrics.DimensionExhausted ?? {}))
      reasons.push(`${dimension} exhausted on ${n} node(s)`);
    for (const [cls, n] of Object.entries(metrics.ClassExhausted ?? {}))
      reasons.push(`class "${cls}" exhausted on ${n} node(s)`);
    for (const quota of metrics.QuotaExhausted ?? []) reasons.push(`quota "${quota}" exhausted`);
    // A group that reports NO reason at all still gets a sentence: "nothing was eligible" is itself the news,
    // and it is what an empty cluster (or one whose nodes are all draining) answers with.
    const evaluated = metrics.NodesEvaluated !== undefined ? ` (${metrics.NodesEvaluated} node(s) evaluated)` : "";
    parts.push(`${group}: ${reasons.length > 0 ? reasons.join(", ") : "no eligible node"}${evaluated}`);
  }
  return parts.join("; ");
}
