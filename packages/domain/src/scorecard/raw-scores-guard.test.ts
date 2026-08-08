import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The structural half of the measured gate (trust-kernel contract ①): TypeScript cannot forbid a new
// aggregation from reading `result.scores` directly and skipping `isMeasured`, so this guard does — every
// file in the domain that touches a raw `.scores` array must be on the allowlist below, and getting ON the
// allowlist means demonstrating the isMeasured/measuredScores gate (or a producer/worklist role that needs
// the raw rows on purpose). A new consumer failing here is the invariant working, not the test being fussy.
const ALLOWED = new Set([
  "scorecard/scorecard.ts", // summarize/diff — gated via isMeasured/measuredScores + retryableUnmeasured (worklist: raw on purpose)
  "scorecard/verdict-policy.ts", // the verdict engine — gated via measuredScores
  "scorecard/case-outcome.ts", // delegates to caseVerdict (gated)
  "scorecard/scorecard-batch.ts", // aggregate lifecycle — carries results, does not aggregate scores
  "scorecard/scoring-plan.ts", // judge-metric ownership + caseReason — gated via isMeasured/measuredScores (moved from application-control scorecard-shared)
  "trace/spans-to-events.ts", // producer side (no Score consumption) — listed defensively if it ever matches
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

describe("raw-scores guard — no aggregation bypasses the measured gate", () => {
  it("every domain file touching `.scores` is on the gate allowlist", () => {
    const root = join(__dirname, "..");
    const offenders = tsFilesUnder(root).filter((rel) => {
      if (ALLOWED.has(rel)) return false;
      const text = readFileSync(join(root, rel), "utf8");
      return /\.scores\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
