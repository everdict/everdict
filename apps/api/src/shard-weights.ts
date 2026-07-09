// History-informed shard distribution (docs/architecture/batch-resilience.md — tail speculation's preventive
// half). Uniform round-robin gives a runtime that is 3× slower the same share, and the tail speculation then
// CORRECTS the imbalance with duplicate compute. With per-(harness, runtime) duration medians the split is
// proportional to speed up front (weight = 1/median), so the shards finish together and speculation stays a
// safety net instead of a scheduler.
//
// Deterministic smooth weighted round-robin (SWRR): each step credits every target its weight and picks the
// highest credit — even interleave (no long same-target runs), stable for a given (targets, medians) input.
// A target with no history gets the AVERAGE weight (unknown ≠ slow), and with no history at all the split
// degenerates to the uniform round-robin the callers used before.
export function weightedTargets(
  caseCount: number,
  targets: string[],
  medianSecByTarget: Map<string, number>,
): string[] {
  if (targets.length === 0) return [];
  const known = targets.map((t) => medianSecByTarget.get(t)).filter((m): m is number => m !== undefined && m > 0);
  const out: string[] = [];
  if (known.length === 0 || targets.length === 1) {
    for (let i = 0; i < caseCount; i++) out.push(targets[i % targets.length] as string);
    return out;
  }
  const avgWeight = known.reduce((a, m) => a + 1 / m, 0) / known.length;
  const weights = targets.map((t) => {
    const m = medianSecByTarget.get(t);
    return m !== undefined && m > 0 ? 1 / m : avgWeight;
  });
  const total = weights.reduce((a, w) => a + w, 0);
  const credit = new Array<number>(targets.length).fill(0);
  for (let i = 0; i < caseCount; i++) {
    let best = 0;
    for (let j = 0; j < targets.length; j++) {
      credit[j] = (credit[j] as number) + (weights[j] as number);
      if ((credit[j] as number) > (credit[best] as number)) best = j;
    }
    credit[best] = (credit[best] as number) - total;
    out.push(targets[best] as string);
  }
  return out;
}
