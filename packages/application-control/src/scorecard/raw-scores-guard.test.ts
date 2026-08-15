import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The structural half of the measured gate, control-plane side (the twin of
// packages/domain/src/scorecard/raw-scores-guard.test.ts). TypeScript now refuses `.value`/`.pass` on an
// ungated Score — the measurement algebra is a discriminated union — but it cannot forbid a new service from
// TALLYING or FORWARDING raw `.scores` in a way that treats a dead grader as an ordinary row. So this guard
// does: every file here touching a raw `.scores` array is on the allowlist, and getting on it means naming
// the role (gate applied, producer, or a worklist that needs the failures themselves).
// A new consumer failing here is the invariant working, not the test being fussy.
const ALLOWED = new Set([
  "execution/collect-trace.ts", // producer — mints the unmeasured skip row for a non-reconstructable grader
  "execution/scoring-service.ts", // producer — appends judge verdicts + the unresolved-judge unmeasured row
  "scorecard/scorecard-ingest-service.ts", // producer — concatenates derived + uploaded scores onto the case
  "scorecard/scorecard-score-service.ts", // re-score worklist — strips/replaces whole judge families, never averages
  "scorecard/scorecard-observability.ts", // gated: batchSettledEvent tallies the FAILURES on purpose (caseReason moved to @everdict/domain scoring-plan)
  "trace-sink/trace-sink-service.ts", // gated via measuredScores before anything leaves for a platform
  // producer — completes a case's judge coverage before its terminal commit: a selected judge that never
  // answered leaves an explicit unmeasured row rather than no row at all (review 39 P0-3)
  "scorecard/case-outcome-committer.ts",
  // …and the same completion on the ONE path that does not commit through the committer: a recovery adopting
  // a result a backend produced, which re-judges the case before its adopt-settle (arch-review 34 P0).
  "scorecard/recovery-planner.ts",
]);

function tsFilesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

describe("raw-scores guard (control plane) — no consumer bypasses the measured gate", () => {
  it("every application-control file touching `.scores` is on the gate allowlist", () => {
    const root = join(__dirname, "..");
    const offenders = tsFilesUnder(root).filter((rel) => {
      if (ALLOWED.has(rel)) return false;
      return /\.scores\b/.test(readFileSync(join(root, rel), "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
