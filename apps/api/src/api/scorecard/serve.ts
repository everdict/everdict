import type { ScorecardResponse } from "@everdict/contracts/wire";
import type { ScorecardRecord } from "@everdict/db";
import {
  evaluateVerdict,
  evidenceStatus,
  headlinePassRate,
  resolveVerdictPolicy,
  scorecardOutcomes,
} from "@everdict/domain";

// Serve-time enrichment of a scorecard detail (re-architecture P1g): computed derivations ride the
// wire (per-case verdict, casePass rollup, headline pass rate) so no client re-implements the domain
// rules — this deleted the apps/web verdict mirror and the SDK headline mirror. Enrichment happens at
// the transport boundary (HTTP route + MCP tool call this one mapper), never persisted — old records
// get the fields too, and internal readers (analytics/diff/export) keep seeing the raw record.
export function serveScorecard(record: ScorecardRecord): ScorecardResponse {
  const headline = headlinePassRate(record);
  if (!record.scorecard) return { ...record, headlinePassRate: headline };
  // Verdicts resolve under the batch's STAMPED policy (absent = the default ladder those records were judged
  // under) — evolving the policy never silently rewrites a historical verdict.
  const policy = resolveVerdictPolicy(record.verdictPolicy);
  let pass = 0;
  let total = 0;
  const results = record.scorecard.results.map((r) => {
    const { verdict, basis } = evaluateVerdict(r, policy);
    // Evidence completeness rides EVERY served case — a verdict standing on partial evidence says so, and a
    // case with no verdict says why its evidence planes are empty.
    const evidence = evidenceStatus(r);
    if (verdict === undefined) return { ...r, evidenceStatus: evidence };
    total += 1;
    if (verdict) pass += 1;
    // The verdict carries its own basis — which rung decided, under which aggregation, from which measurements.
    return { ...r, verdict, ...(basis ? { verdictBasis: basis } : {}), evidenceStatus: evidence };
  });
  return {
    ...record,
    scorecard: { ...record.scorecard, results },
    casePass: { pass, total },
    headlinePassRate: headline,
    // Case-fate denominators — 841/970 (verdicted) and 841/1000 (requested) are different claims; an
    // infra-failed case is recovery work with NO product verdict, so it never enters pass/total above either.
    outcomes: scorecardOutcomes(record.scorecard),
  };
}
