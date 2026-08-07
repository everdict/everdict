import type { CaseResult } from "@everdict/contracts";
import type { ScorecardRecord } from "@everdict/db";
import { verdictPolicyRef } from "@everdict/domain";
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
        // A stale persisted snapshot — the detail read re-derives from the results, so this never serves.
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
    // The headline comes from the RE-DERIVED summary (1 pass / 2 measured), not the stale persisted 2/3.
    expect(served.headlinePassRate).toBeCloseTo(1 / 2);
    expect(served.summary?.find((m) => m.metric === "tests_pass")).toMatchObject({ count: 2, passRate: 1 / 2 });
    // The verdict explains itself: which rung decided, from which measurements — b's ground truth overruled
    // its judge, and the basis says so.
    expect(served.scorecard?.results[1]?.verdictBasis).toEqual({
      authority: "ground_truth",
      aggregation: "priority",
      deciders: [{ metric: "tests_pass", graderId: "tests_pass", pass: false }],
    });
    expect(served.outcomes).toEqual({
      executed: 3,
      gradeable: 3,
      verdicted: 2,
      passed: 1,
      failed: 1,
      infraFailed: 0,
      cancelled: 0,
      unmeasured: 1,
    });
  });

  it("an infra-failed case gets no verdict and lands only in the infraFailed denominator", () => {
    const dead: CaseResult = {
      ...caseResult("z", []),
      failure: {
        stage: "dispatch",
        class: "infra",
        code: "UPSTREAM_ERROR",
        message: "placement blip",
        retryable: true,
      },
    };
    const served = serveScorecard(
      record({
        scorecard: {
          suiteId: "d@1.0.0",
          harness: "h@1.0.0",
          results: [caseResult("a", [{ metric: "tests_pass", value: 1, pass: true }]), dead],
        },
      }),
    );
    // The platform failing the case never reads as the agent failing the task
    expect(served.scorecard?.results.find((r) => r.caseId === "z")?.verdict).toBeUndefined();
    expect(served.casePass).toEqual({ pass: 1, total: 1 });
    expect(served.outcomes).toMatchObject({ executed: 2, gradeable: 1, verdicted: 1, infraFailed: 1 });
  });

  it("the persisted ask rides the denominators — requested − executed is the unlaunched tally", () => {
    const served = serveScorecard(
      record({
        requested: 5, // sealed at submit (cases × trials); 4 never launched (cancelled batch)
        scorecard: {
          suiteId: "d@1.0.0",
          harness: "h@1.0.0",
          results: [caseResult("a", [{ metric: "tests_pass", value: 1, pass: true }])],
        },
      }),
    );
    expect(served.outcomes).toMatchObject({ requested: 5, executed: 1 });
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

  it("a detail read normalizes a pre-gate persisted summary — a dead grader's mean:0 never serves again", () => {
    // Given a record aggregated BEFORE the measurement gate existed: its persisted summary crowned a fully
    // unmeasured metric with a literal zero (count:0 mean:0 passRate:0), and a diagnostic-only row leaked in.
    const unmeasuredOnly: CaseResult = {
      ...caseResult("a", []),
      scores: [
        {
          graderId: "judge",
          metric: "judge:q",
          value: 0,
          status: "unmeasured",
          reason: "grader_error",
          retryable: true,
        },
      ],
    };
    const served = serveScorecard(
      record({
        summary: [
          { metric: "judge:q", count: 0, mean: 0, passRate: 0 },
          { metric: "error", count: 0, mean: 0 },
        ],
        scorecard: { suiteId: "d@1.0.0", harness: "h@1.0.0", results: [unmeasuredOnly] },
      }),
    );
    // Then the served summary is re-derived under the current semantics: the annihilated metric keeps its
    // unmeasured tally but carries NO mean/passRate, the poisoned row is gone, and nothing headline-decides.
    const judge = served.summary?.find((m) => m.metric === "judge:q");
    expect(judge).toMatchObject({ count: 0, unmeasured: 1 });
    expect(judge?.mean).toBeUndefined();
    expect(judge?.passRate).toBeUndefined();
    expect(served.summary?.find((m) => m.metric === "error")).toBeUndefined();
    expect(served.headlinePassRate).toBeNull();
  });

  it("an UNRESOLVABLE stamped policy serves no verdict at all — never numbers re-judged under the default ladder", () => {
    // Given a batch stamped with a COMPOSED policy (it lives only in the manifest) whose manifest is gone —
    // the shape a detail read gets when the embedded document was never persisted or no longer matches.
    // Pre-fix, resolveVerdictPolicy answered DEFAULT_VERDICT_POLICY here, so `schema_valid` dropped to the
    // fallback rung, the judge decided instead, and the batch served a PASS it was never judged to have.
    const served = serveScorecard(
      record({
        verdictPolicy: { id: "composed", version: "abc123def456", digest: "a-digest-with-no-document" },
        scorecard: {
          suiteId: "d@1.0.0",
          harness: "h@1.0.0",
          results: [
            caseResult("a", [
              { metric: "schema_valid", value: 0, pass: false },
              { metric: "judge", value: 1, pass: true },
            ]),
          ],
        },
      }),
    );
    expect(served.policyResolution).toBe("unresolvable");
    expect(served.scorecard?.results[0]?.verdict).toBeUndefined();
    expect(served.scorecard?.results[0]?.verdictBasis).toBeUndefined();
    expect(served.casePass).toBeUndefined();
    expect(served.outcomes).toBeUndefined();
    // Evidence completeness reads the result alone, so it survives the missing policy.
    expect(served.scorecard?.results[0]?.evidenceStatus).toBeDefined();
  });

  it("a resolvable stamp says so, and a stamp-less record says legacy_default", () => {
    const results = [caseResult("a", [{ metric: "tests_pass", value: 1, pass: true }])];
    const sc = { suiteId: "d@1.0.0", harness: "h@1.0.0", results };
    expect(serveScorecard(record({ scorecard: sc })).policyResolution).toBe("legacy_default");
    expect(
      serveScorecard(
        record({
          scorecard: sc,
          verdictPolicy: verdictPolicyRef(),
        }),
      ).policyResolution,
    ).toBe("resolved");
  });

  it("leaves a result-less record untouched apart from the headline", () => {
    const served = serveScorecard(record({ status: "queued" }));
    expect(served.headlinePassRate).toBeNull();
    expect(served.scorecard).toBeUndefined();
    expect(served.casePass).toBeUndefined();
  });
});
