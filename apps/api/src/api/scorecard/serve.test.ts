import type { CaseResult } from "@everdict/contracts";
import type { ScorecardRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { serveScorecard } from "./serve.js";

type ScoreOver = { metric: string; value: number; pass?: boolean };
const caseResult = (caseId: string, scores: ScoreOver[]): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  scores: scores.map((s) => ({ graderId: s.metric, ...s })),
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0000000" },
});

const record = (over: Partial<ScorecardRecord>): ScorecardRecord => ({
  id: "sc1",
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1.0.0" },
  status: "succeeded",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("serveScorecard (P1g served derivations — the client mirrors are deleted)", () => {
  it("serves per-case verdict + casePass rollup + headline on a detail record", () => {
    const served = serveScorecard(
      record({
        summary: [{ metric: "tests_pass", count: 3, mean: 2 / 3, passRate: 2 / 3 }],
        scorecard: {
          suiteId: "d@1.0.0",
          harness: "h@1.0.0",
          results: [
            caseResult("a", [{ metric: "tests_pass", value: 1, pass: true }]),
            // The judge cannot override ground truth — authority ranking is the server's, once.
            caseResult("b", [
              { metric: "tests_pass", value: 0, pass: false },
              { metric: "judge", value: 1, pass: true },
            ]),
            caseResult("c", [{ metric: "steps", value: 12 }]), // nothing pass-deciding → no verdict
          ],
        },
      }),
    );
    expect(served.scorecard?.results.map((r) => r.verdict)).toEqual([true, false, undefined]);
    expect(served.casePass).toEqual({ pass: 1, total: 2 });
    expect(served.headlinePassRate).toBeCloseTo(2 / 3);
  });

  it("prefers the trial-aware passAt1 for the headline", () => {
    const served = serveScorecard(
      record({
        summary: [{ metric: "tests_pass", count: 5, mean: 0.8, passRate: 0.8 }],
        trialSummary: {
          cases: 1,
          minTrials: 5,
          maxTrials: 5,
          passAt1: 0.6,
          k: 5,
          passAtK: 1,
          flakyCases: 1,
          flakeRate: 1,
        },
      }),
    );
    expect(served.headlinePassRate).toBe(0.6);
    expect(served.casePass).toBeUndefined(); // no per-case results on this record
  });

  it("leaves a result-less record untouched apart from the headline", () => {
    const served = serveScorecard(record({ status: "queued" }));
    expect(served.headlinePassRate).toBeNull();
    expect(served.scorecard).toBeUndefined();
    expect(served.casePass).toBeUndefined();
  });
});
