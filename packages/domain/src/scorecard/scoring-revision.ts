import type { CaseResult, Score, ScoringRevision } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";
import { childKey } from "./scoring-plan.js";

// Scoring identity (docs/architecture/experiment-identity: the JUDGMENT axis) — the pure decisions behind
// ScorecardRecord.scoring. The live score plane mutates in place on a re-score, so identity lives in an
// append-only revision ledger: each pass digests the plane it left behind, and consumers (gates, diffs,
// auditors) pin the digest they read instead of trusting a record id to keep meaning one judgment.

// The judgment projection of one score — what the pass CLAIMED, stripped of narration. `detail` (a judge's
// rationale prose) and `retryable` (recovery advice) explain a judgment without being one: hashing them
// would move scoring identity when a judge merely re-words itself. `status` is normalized to its explicit
// form so a measured row digests identically with and without the optional literal.
function judgmentOf(s: Score): Record<string, unknown> {
  if (s.status === "unmeasured" || s.status === "invalid")
    return { graderId: s.graderId, metric: s.metric, status: s.status, reason: s.reason };
  return {
    graderId: s.graderId,
    metric: s.metric,
    status: "measured",
    value: s.value,
    ...(s.pass !== undefined ? { pass: s.pass } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
  };
}

// Digest of the FULL score plane — caseId#trial → judgment-projected scores, canonically ordered on both
// axes so storage order never moves identity (contentDigest canonicalizes object keys; score arrays are
// sorted here because array order is content).
export function scorePlaneDigest(results: CaseResult[]): string {
  const plane: Record<string, unknown[]> = {};
  for (const r of results) {
    const scores = [...r.scores].sort(
      (a, b) => a.metric.localeCompare(b.metric) || a.graderId.localeCompare(b.graderId),
    );
    plane[childKey(r.caseId, r.trial)] = scores.map(judgmentOf);
  }
  return contentDigest(plane);
}

export interface ScoringPassInput {
  kind: ScoringRevision["kind"];
  judges: ScoringRevision["judges"];
  judgeRun?: NonNullable<ScoringRevision["judgeRun"]>;
  results: CaseResult[];
  analysisRef?: string;
  analysisKey?: string; // its durable object key (the ref expires; artifacts are pass-keyed)
  createdAt: string;
  createdBy?: string;
}

// The revision number the NEXT pass will bear — the one arithmetic owner (appendScoringRevision births the
// entry with this same number; offload sites name the per-revision artifact with it BEFORE the append, so
// the artifact key and the ledger entry can never disagree about which revision they describe).
export function nextScoringRevision(previous: ScoringRevision[] | undefined): number {
  return (previous?.at(-1)?.revision ?? 0) + 1;
}

// Append one scoring pass to the ledger — the ONLY way a revision is born, so numbering (strictly
// increasing, 1-based) and the plane digest cannot drift between the settle and re-score choke points.
export function appendScoringRevision(
  previous: ScoringRevision[] | undefined,
  input: ScoringPassInput,
): ScoringRevision[] {
  const prior = previous ?? [];
  return [
    ...prior,
    {
      revision: nextScoringRevision(prior),
      kind: input.kind,
      judges: input.judges,
      ...(input.judgeRun ? { judgeRun: input.judgeRun } : {}),
      scorePlaneDigest: scorePlaneDigest(input.results),
      ...(input.analysisRef !== undefined ? { analysisRef: input.analysisRef } : {}),
      // The artifact's durable KEY travels with its ref: the ref is a presigned URL that expires, and the
      // object is keyed by the writing PASS (two passes can target one revision), so the revision number no
      // longer names it. Dropping this here would leave every historical read holding a dead URL.
      ...(input.analysisKey !== undefined ? { analysisKey: input.analysisKey } : {}),
      createdAt: input.createdAt,
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    },
  ];
}

// The pin a gate records for one side of a comparison — the CURRENT revision's identity at decision time.
// undefined when the record predates the ledger: absence is the honest answer, never a placeholder pin.
export function currentScoringPin(
  scoring: ScoringRevision[] | undefined,
): { revision: number; scorePlaneDigest: string } | undefined {
  const last = scoring?.at(-1);
  return last ? { revision: last.revision, scorePlaneDigest: last.scorePlaneDigest } : undefined;
}
