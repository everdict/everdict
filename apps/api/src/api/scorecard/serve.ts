import type { ScorecardResponse } from "@everdict/contracts/wire";
import type { ScorecardRecord } from "@everdict/db";
import { caseVerdict, headlinePassRate } from "@everdict/domain";

// Serve-time enrichment of a scorecard detail (re-architecture P1g): computed derivations ride the
// wire (per-case verdict, casePass rollup, headline pass rate) so no client re-implements the domain
// rules — this deleted the apps/web verdict mirror and the SDK headline mirror. Enrichment happens at
// the transport boundary (HTTP route + MCP tool call this one mapper), never persisted — old records
// get the fields too, and internal readers (analytics/diff/export) keep seeing the raw record.
export function serveScorecard(record: ScorecardRecord): ScorecardResponse {
  const headline = headlinePassRate(record);
  if (!record.scorecard) return { ...record, headlinePassRate: headline };
  let pass = 0;
  let total = 0;
  const results = record.scorecard.results.map((r) => {
    const verdict = caseVerdict(r);
    if (verdict === undefined) return r;
    total += 1;
    if (verdict) pass += 1;
    return { ...r, verdict };
  });
  return {
    ...record,
    scorecard: { ...record.scorecard, results },
    casePass: { pass, total },
    headlinePassRate: headline,
  };
}
