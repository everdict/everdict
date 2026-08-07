import type { ScorecardResponse } from "@everdict/contracts/wire";
import type { ScorecardRecord } from "@everdict/db";
import {
  evaluateVerdict,
  evidenceStatus,
  headlinePassRate,
  resolveVerdictPolicy,
  retryableUnmeasured,
  scorecardOutcomes,
  summarizeScorecard,
} from "@everdict/domain";

// Serve-time enrichment of a scorecard detail (re-architecture P1g): computed derivations ride the
// wire (per-case verdict, casePass rollup, headline pass rate) so no client re-implements the domain
// rules — this deleted the apps/web verdict mirror and the SDK headline mirror. Enrichment happens at
// the transport boundary (HTTP route + MCP tool call this one mapper), never persisted — old records
// get the fields too, and internal readers (analytics/diff/export) keep seeing the raw record.
// List-item enrichment — the authority-ranked headline rides the LIST too, so no client re-derives a
// "representative metric" from summary order (summary order is not authority).
export function serveScorecardListItem(record: ScorecardRecord): ScorecardResponse {
  return { ...record, headlinePassRate: headlinePassRate(record) };
}

export function serveScorecard(record: ScorecardRecord): ScorecardResponse {
  if (!record.scorecard) return { ...record, headlinePassRate: headlinePassRate(record) };
  // The persisted summary is a snapshot of the aggregation semantics at settle time — a record aggregated
  // before the measurement gate can still carry a dead grader's mean:0 or a diagnostic's poisoned row. When
  // the per-case results are in hand (detail reads), the summary is RE-DERIVED under the current semantics,
  // so every historical detail is normalized at the same read-time boundary the verdicts are. List reads
  // (no results) keep the persisted snapshot — they cannot recompute, and the headline ranking tolerates it.
  const summary = summarizeScorecard(record.scorecard);
  const headline = headlinePassRate({ ...record, summary });
  // Verdicts resolve under the batch's STAMPED policy (absent = the default ladder those records were judged
  // under) — evolving the policy never silently rewrites a historical verdict.
  const policy = resolveVerdictPolicy(record.verdictPolicy, record.manifest?.verdictPolicy);
  const recoverable = retryableUnmeasured(record.scorecard).length;
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
    summary,
    scorecard: { ...record.scorecard, results },
    casePass: { pass, total },
    headlinePassRate: headline,
    // Case-fate denominators — 841/970 (verdicted) and 841/1000 (requested) are different claims; an
    // infra-failed case is recovery work with NO product verdict, so it never enters pass/total above either.
    outcomes: scorecardOutcomes(record.scorecard, record.requested),
    // Transient scoring failures a targeted re-score can recover — the web's rescore button shows iff > 0.
    ...(recoverable > 0 ? { retryableUnmeasured: recoverable } : {}),
  };
}
