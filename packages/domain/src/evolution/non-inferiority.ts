import type { NonInferiorityPolicy, NonInferiorityResult } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// Simultaneous bounded-Bernoulli intervals. Four one-sided Hoeffding tails per case,
// Bonferroni-corrected over the predeclared family. Assumes independent trials in each
// arm; does not require independence between arms or cases (union bound).
export function nonInferiorityOf(
  policy: NonInferiorityPolicy,
  heldOutIds: readonly string[],
  familySize: number,
  rows: ReadonlyArray<{
    caseId: string;
    baselineRate: number;
    candidateRate: number;
    baselineTrials: number;
    candidateTrials: number;
  }>,
): NonInferiorityResult {
  const logTail = Math.log((4 * Math.max(1, heldOutIds.length) * Math.max(1, familySize)) / policy.alpha);
  const cases: NonInferiorityResult["cases"] = heldOutIds.map((caseId) => {
    const matches = rows.filter((r) => r.caseId === caseId);
    const row = matches[0];
    const baselineTrials = row?.baselineTrials ?? 0;
    const candidateTrials = row?.candidateTrials ?? 0;
    const identity = { caseId, baselineTrials, candidateTrials };
    if (
      matches.length !== 1 ||
      row === undefined ||
      !Number.isInteger(baselineTrials) ||
      !Number.isInteger(candidateTrials) ||
      baselineTrials < policy.minimumTrials ||
      candidateTrials < policy.minimumTrials ||
      ![row.baselineRate, row.candidateRate].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      return { ...identity, status: "inconclusive" };
    const radius = Math.sqrt(logTail / (2 * baselineTrials)) + Math.sqrt(logTail / (2 * candidateTrials));
    const delta = row.candidateRate - row.baselineRate;
    const lowerDelta = Math.max(-1, delta - radius);
    const upperDelta = Math.min(1, delta + radius);
    return {
      ...identity,
      lowerDelta,
      upperDelta,
      status: lowerDelta >= -policy.margin ? "non_inferior" : upperDelta < -policy.margin ? "inferior" : "inconclusive",
    };
  });
  return {
    policyDigest: contentDigest(policy),
    cases,
    status: cases.some((c) => c.status === "inferior")
      ? "inferior"
      : cases.length > 0 && cases.every((c) => c.status === "non_inferior")
        ? "non_inferior"
        : "inconclusive",
  };
}
